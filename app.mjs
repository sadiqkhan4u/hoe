import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const destination = 'https://filmymantra.com/';

async function openCounters(dataDir) {
  if (!isAbsolute(dataDir)) throw new Error('COUNTER_DATA_DIR must be an absolute path.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const filename = join(dataDir, 'counters.json');
  let totals = { visits: 0, clicks: 0 };
  try {
    totals = JSON.parse(await readFile(filename, 'utf8'));
    if (!['visits', 'clicks'].every(key => Number.isSafeInteger(totals[key]) && totals[key] >= 0)) {
      throw new Error('Invalid counter data: restore the saved counters.json backup.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let pending = Promise.resolve();
  return {
    read: async () => { await pending; return { ...totals }; },
    increment: (key) => {
      const operation = pending.then(async () => {
        const next = { ...totals, [key]: totals[key] + 1 };
        if (!Number.isSafeInteger(next[key])) throw new Error('Counter limit exceeded.');
        const temporary = filename + '.' + randomUUID() + '.tmp';
        await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
        await rename(temporary, filename);
        totals = next;
        return { ...totals };
      });
      pending = operation.catch(() => {});
      return operation;
    }
  };
}

export async function createApp({
  dataDir = process.env.COUNTER_DATA_DIR || join(homedir(), '.hoe', 'data'),
  secureCookies = process.env.NODE_ENV === 'production'
} = {}) {
  const counters = await openCounters(dataDir);
  const template = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
  const cookie = (name) => name + '=1; Path=/; HttpOnly; SameSite=Lax' + (secureCookies ? '; Secure' : '');
  const seen = (request, name) => (request.headers.cookie || '').split(';').some(item => item.trim() === name + '=1');
  const format = (value) => value.toLocaleString('en-US');

  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': type });
      response.end(request.method === 'HEAD' ? undefined : body);
    };
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.setHeader('Allow', 'GET, HEAD');
        return send(405, 'Method not allowed');
      }
      if (pathname === '/health') return send(200, '{"status":"ok"}', 'application/json');
      if (pathname === '/api/counters') return send(200, JSON.stringify(await counters.read()), 'application/json');
      if (pathname === '/filmymantra') {
        if (request.method === 'GET' && !seen(request, 'hoe_clicked')) {
          try {
            await counters.increment('clicks');
            response.setHeader('Set-Cookie', cookie('hoe_clicked'));
          } catch (error) {
            console.error('Click counter write failed:', error.message);
          }
        }
        response.writeHead(302, { Location: destination });
        return response.end();
      }
      if (pathname !== '/') return send(404, 'Page not found');
      let totals;
      if (request.method === 'GET' && !seen(request, 'hoe_visited')) {
        try {
          totals = await counters.increment('visits');
          response.setHeader('Set-Cookie', cookie('hoe_visited'));
        } catch (error) {
          console.error('Visit counter write failed:', error.message);
        }
      } else {
        totals = await counters.read();
      }
      const html = template.replaceAll('{{visits}}', totals ? format(totals.visits) : 'Unavailable')
        .replaceAll('{{clicks}}', totals ? format(totals.clicks) : 'Unavailable');
      return send(200, html, 'text/html; charset=utf-8');
    } catch (error) {
      console.error('Request failed:', error.message);
      return send(500, 'Please try again shortly.');
    }
  });
}
