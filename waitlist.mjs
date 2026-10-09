// Team notifications are sent only after explicit inbox confirmation.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const success = { message: "Your spark is almost on the list. 💌\n\nWe’re building a little heaven for real connections, playful souls and people who actually want to show up.\n\nCheck your inbox, open the confirmation link and tap “Confirm my email” to finish joining. That little extra effort confirms we can reach you—and helps cut down on bots, spam and fake signups crashing the party.\n\nGood hands? We’re aiming for good vibes… and good HOEs. 😉\n\nAlready confirmed? You’re on the list. Keep that halo handy." };
const CONFIRM_TTL = 24 * 60 * 60 * 1000;
const RESEND_COOLDOWN = 15 * 60 * 1000;
const hashToken = token => createHash('sha256').update(token).digest('hex');
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const mailStatuses = ['sending', 'sent', 'uncertain'];
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

function readPayload(request, formEncoded = false) {
  const contentType = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== (formEncoded ? 'application/x-www-form-urlencoded' : 'application/json')) {
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
        const raw = Buffer.concat(chunks).toString('utf8');
        const fields = formEncoded ? new URLSearchParams(raw) : null;
        if (fields && (fields.getAll('token').length !== 1 || [...fields.keys()].some(key => key !== 'token'))) throw new Error();
        const value = fields ? { token: fields.get('token') } : JSON.parse(raw);
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
        new Set(entries.map(entry => entry?.email)).size !== entries.length ||
        entries.some(entry => {
          if (!entry || normalizeEmail(entry.email) !== entry.email || !validTime(entry.joinedAt)) return true;
          if (entry.version === undefined) return !mailStatuses.includes(entry.notification);
          const confirmation = entry.confirmation;
          return entry.version !== 2 || typeof entry.id !== 'string' ||
            !['pending', ...mailStatuses].includes(entry.notification) ||
            !(entry.verifiedAt === null || validTime(entry.verifiedAt)) ||
            (entry.notification !== 'pending' && (!entry.verifiedAt || !validTime(entry.notificationAttemptedAt))) ||
            !confirmation || !/^[a-f0-9]{64}$/.test(confirmation.hash || '') ||
            !validTime(confirmation.expiresAt) || !Array.isArray(confirmation.attempts) ||
            confirmation.attempts.length < 1 || confirmation.attempts.length > 3 ||
            confirmation.attempts.some(attempt => !validTime(attempt.attemptedAt) || !mailStatuses.includes(attempt.status));
        })) {
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
      const index = entries.findIndex(entry => entry.email === email);
      const existing = index < 0 ? null : entries[index];
      const timestamp = new Date(now()).toISOString();
      const day = timestamp.slice(0, 10);
      const sentToday = entries.reduce((total, entry) => total +
        (entry.confirmation?.attempts || []).filter(attempt => attempt.attemptedAt.startsWith(day)).length, 0);
      // Apply the daily response uniformly so an exhausted cap cannot reveal whether an address already signed up.
      if (sentToday >= config.dailyLimit) reject(429, 'The waitlist is busy. Please try again tomorrow.');
      if (existing?.verifiedAt) return success;
      const attempts = (existing?.confirmation?.attempts || [])
        .filter(attempt => now() - Date.parse(attempt.attemptedAt) < CONFIRM_TTL);
      const previous = attempts.at(-1);
      // An explicit new signup can resend, but duplicates and ambiguous timeouts never trigger an immediate retry.
      if (previous && now() - Date.parse(previous.attemptedAt) < RESEND_COOLDOWN || attempts.length >= 3) return success;
      if (index < 0 && entries.length >= 100000) {
        reject(429, 'The waitlist is busy. Please try again tomorrow.');
      }
      const token = randomBytes(32).toString('base64url');
      const entry = {
        ...(existing || { id: randomUUID(), email, joinedAt: timestamp }),
        version: 2, consentAt: timestamp, consent: 'hoe-launch-updates-v1', verifiedAt: null,
        notification: 'pending',
        confirmation: { hash: hashToken(token), expiresAt: new Date(now() + CONFIRM_TTL).toISOString(),
          attempts: [...attempts, { attemptedAt: timestamp, status: 'sending' }] }
      };
      // Preserve the original notification history when an old, unverified signup asks to confirm.
      if (existing && existing.version === undefined) {
        entry.legacyNotification = { status: existing.notification, attemptedAt: existing.attemptedAt || existing.joinedAt };
        delete entry.attemptedAt;
      }
      const next = [...entries];
      const position = index < 0 ? next.length : index;
      next[position] = entry;
      await save(next);
      const confirmationUrl = origin + '/confirm?token=' + token;
      const status = await sendMail({
        to: [email], displayName: 'Heaven On Earth', subject: 'Confirm your HOE waitlist email',
        text: 'Confirm your Heaven On Earth launch waitlist email\n\n' +
          'You requested HOE launch updates. Open this link, then press Confirm my email:\n' +
          confirmationUrl + '\n\nThis link expires in 24 hours. You are only added to the verified waitlist after confirmation.\n' +
          'If you did not request this, ignore this email. No updates will be sent without confirmation.'
      });
      const completed = { ...entries[position], confirmation: { ...entry.confirmation,
        attempts: entry.confirmation.attempts.map((attempt, i) => i === entry.confirmation.attempts.length - 1 ? { ...attempt, status } : attempt) } };
      try { await save(entries.map((value, i) => i === position ? completed : value)); }
      catch { console.error('Waitlist confirmation state could not be saved; review private storage.'); }
      if (status !== 'sent') console.error('Waitlist confirmation delivery requires review; no automatic resend was attempted.');
      return success;
    });
  }

  async function sendMail(payload) {
    try {
      const response = await fetchImpl('https://api.mail.hostinger.com/api/v1/mailboxes/' + encodeURIComponent(config.mailboxId) + '/send', {
        method: 'POST', headers: { Authorization: 'Bearer ' + config.mailToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10000)
      });
      return response.ok ? 'sent' : 'uncertain';
    } catch { return 'uncertain'; }
  }

  const confirmationIndex = token => validToken(token) ? entries.findIndex(entry =>
    entry.version === 2 && entry.confirmation.hash === hashToken(token)) : -1;
  const confirmationPage = (message, token = null) => '<!doctype html><html lang="en"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="strict-origin"><meta name="robots" content="noindex,nofollow">' +
    '<title>Confirm your email · Heaven On Earth</title><style>' +
    '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;' +
    'background:#21131d;color:#fff0d9;font:16px/1.6 system-ui,sans-serif}' +
    'main{width:100%;max-width:480px;text-align:center;padding:32px;border:1px solid #62404f;border-radius:24px}' +
    'h1{font:36px/1.2 Georgia,serif}p{color:#dbcbd3}button,a{display:inline-block;border:0;border-radius:12px;' +
    'padding:14px 24px;background:linear-gradient(110deg,#ffe3ac,#ef5e91);color:#27141f;font:600 16px system-ui;text-decoration:none}' +
    '</style></head><body><main><h1>Heaven On Earth</h1><p>' + message + '</p>' +
    (token ? '<form method="post" action="/confirm"><input type="hidden" name="token" value="' + token +
      '"><button type="submit">Confirm my email</button></form>' : '<a href="/">Back to HOE</a>') +
    '</main></body></html>';

  async function confirm(request) {
    if (!available) reject(503, 'Email confirmation is temporarily unavailable. Please try again later.');
    if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
      reject(403, 'Please open your confirmation link and use the button on our website.');
    }
    const body = await readPayload(request, true);
    return serialized(async () => {
      const index = confirmationIndex(body.token);
      if (index < 0) reject(400, 'This confirmation link is invalid. Please join the waitlist again.');
      const entry = entries[index];
      if (entry.verifiedAt) return 'Your email is confirmed. You are on the HOE launch waitlist.';
      if (Date.parse(entry.confirmation.expiresAt) <= now()) reject(400, 'This confirmation link has expired. Please join the waitlist again.');
      const timestamp = new Date(now()).toISOString();
      // Consume the token and claim the team notice before calling the provider.
      const verified = { ...entry, verifiedAt: timestamp, notification: 'sending', notificationAttemptedAt: timestamp };
      await save(entries.map((value, position) => position === index ? verified : value));
      const status = await sendMail({
        to: ['connect@feyros.com'], displayName: 'Heaven On Earth', subject: 'HOE — verified waitlist signup',
        text: 'Verified HOE launch waitlist signup\n\nEmail: ' + entry.email +
          '\nJoined: ' + entry.joinedAt + '\nVerified: ' + timestamp +
          '\nConsent: HOE launch updates\nReference: ' + entry.id +
          '\n\nThe recipient confirmed access to this email address. This does not verify their identity or trustworthiness.'
      });
      try { await save(entries.map((value, position) => position === index ? { ...verified, notification: status } : value)); }
      catch { console.error('Verified waitlist notification state could not be saved; review private storage.'); }
      if (status !== 'sent') console.error('Verified waitlist notification requires review; no automatic resend was attempted.');
      return 'Your email is confirmed. You are on the HOE launch waitlist.';
    });
  }

  return {
    publicConfig, form,
    async handleConfirmation(request, response) {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'strict-origin');
      response.setHeader('X-Robots-Tag', 'noindex, nofollow');
      const send = (status, message, token = null) => {
        response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(request.method === 'HEAD' ? undefined : confirmationPage(message, token));
      };
      try {
        if (request.method === 'POST') return send(200, await confirm(request));
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.setHeader('Allow', 'GET, HEAD, POST');
          return send(405, 'Please use the confirmation link in your email.');
        }
        const token = new URL(request.url, origin).searchParams.get('token');
        const index = confirmationIndex(token);
        if (index < 0) reject(400, 'This confirmation link is invalid. Please join the waitlist again.');
        if (entries[index].verifiedAt) return send(200, 'Your email is already confirmed. You are on the HOE launch waitlist.');
        if (Date.parse(entries[index].confirmation.expiresAt) <= now()) reject(400, 'This confirmation link has expired. Please join the waitlist again.');
        return send(200, 'One more step. Confirm that you want HOE launch updates at this email address.', token);
      } catch (error) {
        if (!error.status) console.error('Email confirmation failed; check private storage and provider configuration.');
        return send(error.status || 503, error.status ? error.message : 'Please try again shortly.');
      }
    },
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
