import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApp } from '../dist/app.mjs';

async function fixture(t, dataDir) {
  const directory = dataDir || await mkdtemp(join(tmpdir(), 'hoe-test-'));
  const server = await createApp({ dataDir: directory, secureCookies: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (!dataDir) await rm(directory, { recursive: true, force: true });
  });
  return { server, url, directory };
}

test('landing page works; refresh and HEAD do not double-count a browser session', async t => {
  const { url } = await fixture(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Coming soon/);
  assert.match(html, /Work in progress/);
  assert.match(html, /src="\/hoe-logo.png"/);
  assert.match(html, /Browser visits/);
  assert.doesNotMatch(html, /filmymantra|link clicks/i);
  assert.doesNotMatch(html, /\{\{/);
  assert.match(page.headers.get('cache-control'), /no-store/);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^hoe_visited=1$/);
  await fetch(url, { headers: { Cookie: cookie } });
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(await head.text(), '');
  assert.deepEqual(await (await fetch(url + '/api/counters')).json(), { visits: 1 });
});

test('retired outgoing route has no redirect and no click metric', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url + '/filmymantra', { redirect: 'manual' });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('location'), null);
  assert.deepEqual(await (await fetch(url + '/api/counters')).json(), { visits: 0 });
});

test('concurrent visits persist accurately across application restart', async t => {
  const { url, directory, server } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, () => fetch(url)));
  assert.deepEqual(await (await fetch(url + '/api/counters')).json(), { visits: 20 });
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  const restarted = await fixture(t, directory);
  assert.deepEqual(await (await fetch(restarted.url + '/api/counters')).json(), { visits: 20 });
});

test('private files and unsupported methods are not exposed', async t => {
  const { url } = await fixture(t);
  for (const path of ['/app.mjs', '/.env', '/counters.json', '/../package.json']) {
    assert.equal((await fetch(url + path)).status, 404);
  }
  const response = await fetch(url, { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.deepEqual(await (await fetch(url + '/api/counters')).json(), { visits: 0 });
});

test('invalid saved data causes a clear startup failure rather than resetting totals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hoe-invalid-'));
  try {
    await writeFile(join(directory, 'counters.json'), '{"visits":-1,"clicks":2}');
    await assert.rejects(createApp({ dataDir: directory }), /Invalid counter data/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('actual deployment entry starts on PORT and serves the health endpoint', async t => {
  const { server } = await fixture(t);
  const port = server.address().port;
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  const directory = await mkdtemp(join(tmpdir(), 'hoe-entry-'));
  const child = spawn(process.execPath, ['dist/server.mjs'], {
    env: { ...process.env, PORT: String(port), COUNTER_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const ready = await Promise.race([
    new Promise(resolve => child.stdout.on('data', () => resolve(true))),
    once(child, 'exit').then(() => false),
    new Promise(resolve => setTimeout(() => resolve(false), 5000).unref())
  ]);
  assert.equal(ready, true, logs);
  const response = await fetch('http://127.0.0.1:' + port + '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('failed counter writes keep the homepage usable', async t => {
  const { url, directory } = await fixture(t);
  await rm(directory, { recursive: true, force: true });
  await writeFile(directory, 'The directory is no longer writable.');
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Unavailable/);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('production session cookies include Secure, HttpOnly and SameSite', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hoe-secure-'));
  const server = await createApp({ dataDir: directory, secureCookies: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  const response = await fetch('http://127.0.0.1:' + server.address().port);
  const cookie = response.headers.get('set-cookie');
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Lax']) assert.ok(cookie.includes(flag));
  assert.ok(!/Expires|Max-Age/.test(cookie));
});

test('supplied logo is served unchanged as PNG without incrementing visits', async t => {
  const { url } = await fixture(t);
  const expected = await readFile(new URL('../dist/public/hoe-logo.png', import.meta.url));
  const response = await fetch(url + '/hoe-logo.png');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  assert.equal(expected.readUInt32BE(16), 1774);
  assert.equal(expected.readUInt32BE(20), 887);
  const head = await fetch(url + '/hoe-logo.png', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.deepEqual(await (await fetch(url + '/api/counters')).json(), { visits: 0 });
});

test('legacy counter storage retains visits and retires click totals on next write', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hoe-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'counters.json'), JSON.stringify({ visits: 147, clicks: 28 }));
  const { url } = await fixture(t, directory);
  assert.deepEqual(await (await fetch(url + '/api/counters')).json(), { visits: 147 });
  await fetch(url);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'counters.json'), 'utf8')), { visits: 148 });
});

test('countdown is already rendered and classic browser script uses JavaScript MIME', async t => {
  const { url } = await fixture(t);
  const page = await fetch(url);
  const html = await page.text();
  for (const unit of ['days', 'hours', 'minutes', 'seconds']) {
    assert.match(html, new RegExp('id="' + unit + '">\\d+</strong>'));
  }
  assert.match(html, /datetime="2026-12-25T08:00:00.000Z"/);
  assert.match(html, /<script defer src="\/site.js\?v=/);
  assert.doesNotMatch(html, /type="module"|\/site.mjs/);
  const script = await fetch(url + '/site.js?v=20261009-1');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
  assert.match(script.headers.get('content-security-policy'), /script-src 'self' https:\/\/challenges.cloudflare.com/);
  assert.doesNotMatch(await script.text(), /^import /m);
  assert.equal((await fetch(url + '/site.mjs')).status, 404);
});
