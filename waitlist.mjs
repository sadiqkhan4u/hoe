import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const success = { message: "You're on the list. We'll let you know when HOE is ready." };
const MAX_BODY = 4096;
const NONCE_TTL = 30 * 60 * 1000;

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const reject = (status, message) => { throw new RequestError(status, message); };

export function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\r\n\0]/.test(value)) return null;
  const email = value.trim().toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2 || parts[0].length > 64 || parts[0].startsWith('.') ||
      parts[0].endsWith('.') || parts[0].includes('..')) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_{}|~-]+$/.test(parts[0])) return null;
  const labels = parts[1].split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  if (!/^[a-z]{2,63}$/.test(labels.at(-1))) return null;
  return email;
}

function readPayload(request) {
  if (!(request.headers['content-type'] || '').startsWith('application/json')) {
    reject(415, 'Please submit the form again.');
  }
  if (Number(request.headers['content-length']) > MAX_BODY) {
    request.resume();
    reject(413, 'That request is too large.');
  }
  return new Promise((resolve, rejectPromise) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        if (!tooLarge) rejectPromise(new RequestError(413, 'That request is too large.'));
        tooLarge = true;
      } else if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { rejectPromise(new RequestError(400, 'Please submit a valid form.')); }
    });
    request.on('error', () => rejectPromise(new RequestError(400, 'Please submit the form again.')));
  });
}

export async function createWaitlist({
  dataDir, secureCookies = true, now = Date.now, fetchImpl = fetch,
  config = {
    origin: process.env.APP_ORIGIN || 'https://hoe.dating',
    siteKey: process.env.TURNSTILE_SITE_KEY || '',
    turnstileSecret: process.env.TURNSTILE_SECRET_KEY || '',
    mailToken: process.env.HOSTINGER_MAIL_API_TOKEN || '',
    mailboxId: process.env.HOSTINGER_MAILBOX_ID || '',
    dailyLimit: Number(process.env.WAITLIST_DAILY_LIMIT || 100)
  },
  minFormAge = 2000
}) {
  const origin = new URL(config.origin).origin;
  const hostname = new URL(origin).hostname;
  if (!Number.isSafeInteger(config.dailyLimit) || config.dailyLimit < 1) throw new Error('Invalid WAITLIST_DAILY_LIMIT.');
  const available = Boolean(config.siteKey && config.turnstileSecret && config.mailToken && /^AC[A-Za-z0-9]+$/.test(config.mailboxId));
  const filename = join(dataDir, 'waitlist.json');
  let entries = [];
  try {
    entries = JSON.parse(await readFile(filename, 'utf8'));
    if (!Array.isArray(entries) || entries.length > 100000 ||
        entries.some(entry => !normalizeEmail(entry.email) || !Number.isFinite(Date.parse(entry.joinedAt)) ||
          !['sending', 'sent', 'uncertain'].includes(entry.notification))) {
      throw new Error('Invalid waitlist data. Restore the waitlist.json backup.');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  let queue = Promise.resolve();
  const serialized = operation => {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  const save = async next => {
    const temporary = filename + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
    await rename(temporary, filename);
    entries = next;
  };
  const secret = randomBytes(32);
  const signature = payload => createHmac('sha256', secret).update(payload).digest('base64url');
  const cookieValue = request => {
    const raw = (request.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('hoe_form='));
    const session = raw?.slice('hoe_form='.length);
    return /^[a-f0-9]{32}$/.test(session || '') ? session : null;
  };
  const rate = new Map();
  let globalWindow = { expires: 0, count: 0 };
  const limit = session => {
    const time = now();
    for (const [key, value] of rate) if (value.expires <= time) rate.delete(key);
    if (globalWindow.expires <= time) globalWindow = { expires: time + 60000, count: 0 };
    if (++globalWindow.count > 30) reject(429, 'Please try again in a minute.');
    if (!rate.has(session) && rate.size >= 5000) reject(429, 'Please try again later.');
    const value = rate.get(session) || { expires: time + 15 * 60000, count: 0 };
    rate.set(session, value);
    if (++value.count > 5) reject(429, 'Please try again a little later.');
  };

  const publicConfig = () => ({ available, siteKey: available ? config.siteKey : null });
  const form = (request, response) => {
    const session = cookieValue(request) || randomBytes(16).toString('hex');
    response.setHeader('Set-Cookie', 'hoe_form=' + session + '; Path=/; HttpOnly; SameSite=Lax' + (secureCookies ? '; Secure' : ''));
    const payload = Buffer.from(JSON.stringify({ session, issued: now(), id: randomUUID() })).toString('base64url');
    return { ...publicConfig(), nonce: available ? payload + '.' + signature(payload) : null };
  };
  const validateNonce = (request, value) => {
    if (typeof value !== 'string' || value.length > 1000) reject(400, 'Refresh the form and try again.');
    const parts = value.split('.');
    if (parts.length !== 2) reject(400, 'Refresh the form and try again.');
    const expected = Buffer.from(signature(parts[0]));
    const provided = Buffer.from(parts[1]);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) reject(400, 'Refresh the form and try again.');
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { reject(400, 'Refresh the form and try again.'); }
    const age = now() - payload.issued;
    if (payload.session !== cookieValue(request) || !Number.isFinite(age) || age < minFormAge || age > NONCE_TTL) {
      reject(400, 'Refresh the form, take a moment, and try again.');
    }
    return payload.session;
  };

  async function submit(request) {
    if (!available) reject(503, 'The waitlist opens soon. Please check back.');
    if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') reject(403, 'Please use the form on our website.');
    const body = await readPayload(request);
    if (body.website) return success;
    const session = validateNonce(request, body.nonce);
    limit(session);
    const email = normalizeEmail(body.email);
    if (!email || body.consent !== true) reject(400, 'Enter a valid email and agree to launch updates.');
    if (typeof body.turnstileToken !== 'string' || body.turnstileToken.length < 1 || body.turnstileToken.length > 2048) {
      reject(400, 'Complete the security check and try again.');
    }

    let verification;
    try {
      const response = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: config.turnstileSecret, response: body.turnstileToken }),
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error();
      verification = await response.json();
    } catch { reject(503, 'The security check is temporarily unavailable. Please try again.'); }
    if (verification.success !== true || verification.hostname !== hostname || verification.action !== 'waitlist') {
      reject(400, 'Complete the security check again.');
    }

    return serialized(async () => {
      if (entries.some(entry => entry.email === email)) return success;
      const day = new Date(now()).toISOString().slice(0, 10);
      if (entries.filter(entry => entry.attemptedAt?.startsWith(day)).length >= config.dailyLimit || entries.length >= 100000) {
        reject(429, 'The waitlist is busy. Please try again tomorrow.');
      }
      const timestamp = new Date(now()).toISOString();
      const entry = { id: randomUUID(), email, joinedAt: timestamp, consentAt: timestamp,
        consent: 'hoe-launch-updates-v1', attemptedAt: timestamp, notification: 'sending' };
      const index = entries.length;
      await save([...entries, entry]);
      let status = 'uncertain';
      try {
        const response = await fetchImpl('https://api.mail.hostinger.com/api/v1/mailboxes/' + encodeURIComponent(config.mailboxId) + '/send', {
          method: 'POST', headers: { Authorization: 'Bearer ' + config.mailToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: ['connect@feyros.com'], displayName: 'Heaven On Earth',
            subject: 'HOE — new waitlist signup',
            text: 'New HOE launch waitlist signup\n\nEmail: ' + email +
              '\nJoined: ' + timestamp + '\nConsent: HOE launch updates\nReference: ' + entry.id +
              '\n\nBot verification passed. Email ownership has not been independently verified.'
          }), signal: AbortSignal.timeout(10000)
        });
        if (response.ok) status = 'sent';
      } catch { /* Keep uncertain: the provider may have accepted the request. */ }
      const next = entries.map((value, position) => position === index ? { ...value, notification: status } : value);
      try { await save(next); } catch { console.error('Waitlist notification state could not be saved; review private storage.'); }
      if (status !== 'sent') console.error('Waitlist notification requires review; no automatic resend was attempted.');
      return success;
    });
  }

  return {
    publicConfig, form,
    async handle(request, response) {
      response.setHeader('Cache-Control', 'no-store');
      const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
      try {
        if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); return send(405, { message: 'Method not allowed' }); }
        return send(200, await submit(request));
      } catch (error) {
        if (!error.status) console.error('Waitlist request failed; check private storage and provider configuration.');
        if (error.status === 429) response.setHeader('Retry-After', '60');
        return send(error.status || 503, { message: error.status ? error.message : 'Please try again shortly.' });
      }
    }
  };
}
