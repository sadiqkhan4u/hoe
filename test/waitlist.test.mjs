import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../dist/app.mjs';

const configuration = {
  origin: 'https://hoe.dating', siteKey: 'public-site-key', turnstileSecret: 'private-bot-secret',
  mailToken: 'private-mail-token', mailboxId: 'ACtestMailbox', dailyLimit: 100
};
async function fixture(t, options = {}) {
  const directory = options.directory || await mkdtemp(join(tmpdir(), 'hoe-waitlist-'));
  let clock = Date.parse('2026-10-08T12:00:00Z');
  const calls = [];
  const provider = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('siteverify')) {
      return new Response(JSON.stringify(options.verification || {
        success: true, hostname: 'hoe.dating', action: 'waitlist'
      }), { status: 200 });
    }
    if (options.mailFails || options.teamMailFails && JSON.parse(init.body).to[0] === 'connect@feyros.com') throw new Error('Provider timed out');
    return new Response('{}', { status: 200 });
  };
  const server = await createApp({
    dataDir: directory, secureCookies: false,
    waitlistOptions: { config: { ...configuration, ...options.config },
      now: () => clock, fetchImpl: provider, minFormAge: options.minFormAge ?? 0 }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (!options.directory) await rm(directory, { recursive: true, force: true });
  });
  async function form() {
    const response = await fetch(url + '/api/waitlist-form');
    return { ...(await response.json()), cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  async function submit(state, fields = {}, headers = {}) {
    return fetch(url + '/api/waitlist', { method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: configuration.origin, Cookie: state.cookie, ...headers
    }, body: JSON.stringify({ email: 'person@example.com', consent: true, website: '',
      nonce: state.nonce, turnstileToken: 'a-valid-token', ...fields }) });
  }
  async function confirm(token, headers = {}) {
    return fetch(url + '/confirm', { method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded', Origin: configuration.origin, ...headers
    }, body: new URLSearchParams({ token }) });
  }
  return { url, directory, calls, form, submit, confirm, server, advance: milliseconds => { clock += milliseconds; } };
}
const mailCalls = calls => calls.filter(call => call.url.includes('api.mail.hostinger.com'));
const records = async directory => JSON.parse(await readFile(join(directory, 'waitlist.json'), 'utf8'));

const confirmationToken = calls => {
  const mail = mailCalls(calls).find(call => JSON.parse(call.init.body).subject === 'Confirm your HOE waitlist email');
  return new URL(JSON.parse(mail.init.body).text.match(/https:\/\/hoe\.dating\/confirm\?token=[A-Za-z0-9_-]+/)[0]).searchParams.get('token');
};

test('signup sends a private confirmation to the submitted address, not the team', async t => {
  const f = await fixture(t);
  const response = await f.submit(await f.form(), { email: ' Person+HOE@Example.com ' });
  assert.equal(response.status, 200);
  assert.match((await response.json()).message, /Check your inbox/);
  const entries = await records(f.directory);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].email, 'person+hoe@example.com');
  assert.equal(entries[0].verifiedAt, null);
  assert.equal(entries[0].notification, 'pending');
  assert.equal(entries[0].confirmation.attempts[0].status, 'sent');
  assert.equal(entries[0].consent, 'hoe-launch-updates-v1');
  const mail = mailCalls(f.calls);
  assert.equal(mail.length, 1);
  const payload = JSON.parse(mail[0].init.body);
  assert.deepEqual(payload.to, ['person+hoe@example.com']);
  assert.equal(payload.html, undefined);
  assert.equal(mail[0].init.headers.Authorization, 'Bearer private-mail-token');
  const token = confirmationToken(f.calls);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(entries[0].confirmation.hash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(await readFile(join(f.directory, 'waitlist.json'), 'utf8'), new RegExp(token));
  assert.deepEqual(await (await fetch(f.url + '/api/counters')).json(), { visits: 0 });
  assert.equal((await fetch(f.url + '/waitlist.json')).status, 404);
});

test('only explicit confirmation verifies email access and sends one team notice', async t => {
  const f = await fixture(t);
  await f.submit(await f.form());
  const token = confirmationToken(f.calls);
  const preview = await fetch(f.url + '/confirm?token=' + token);
  assert.equal(preview.status, 200);
  assert.match(await preview.text(), /Confirm my email/);
  assert.equal(preview.headers.get('referrer-policy'), 'strict-origin');
  assert.equal((await fetch(f.url + '/confirm?token=' + token, { method: 'HEAD' })).status, 200);
  assert.equal((await records(f.directory))[0].verifiedAt, null);
  assert.equal(mailCalls(f.calls).length, 1);
  assert.deepEqual(await (await fetch(f.url + '/api/counters')).json(), { visits: 0 });
  const responses = await Promise.all([f.confirm(token), f.confirm(token)]);
  assert.ok(responses.every(response => response.status === 200));
  const entry = (await records(f.directory))[0];
  assert.equal(entry.verifiedAt, '2026-10-08T12:00:00.000Z');
  assert.equal(entry.notification, 'sent');
  const notice = JSON.parse(mailCalls(f.calls)[1].init.body);
  assert.deepEqual(notice.to, ['connect@feyros.com']);
  assert.match(notice.text, /Verified: 2026-10-08T12:00:00.000Z/);
  assert.match(notice.text, /does not verify their identity or trustworthiness/);
  assert.equal((await f.confirm(token)).status, 200);
  await f.submit(await f.form());
  assert.equal(mailCalls(f.calls).length, 2);
});

test('simultaneous duplicates produce one record and one confirmation email with identical public replies', async t => {
  const f = await fixture(t);
  const state = await f.form();
  const responses = await Promise.all([f.submit(state), f.submit(state)]);
  assert.equal(responses[0].status, 200);
  assert.deepEqual(await responses[0].json(), await responses[1].json());
  assert.equal((await records(f.directory)).length, 1);
  assert.equal(mailCalls(f.calls).length, 1);
});

test('missing private credentials fail closed and do not leak through public config', async t => {
  const f = await fixture(t, { config: { mailToken: '' } });
  const state = await f.form();
  assert.equal(state.available, false);
  assert.equal(state.nonce, null);
  assert.equal((await f.submit(state)).status, 503);
  assert.equal(f.calls.length, 0);
  const response = await fetch(f.url + '/api/public-config');
  const text = await response.text();
  assert.doesNotMatch(text, /private-mail-token|private-bot-secret|ACtestMailbox/);
  assert.equal(JSON.parse(text).launchAt, '2026-12-25T08:00:00.000Z');
});

test('failed bot check or wrong hostname/action produces no mail', async t => {
  for (const verification of [
    { success: false, hostname: 'hoe.dating', action: 'waitlist' },
    { success: true, hostname: 'attacker.example', action: 'waitlist' },
    { success: true, hostname: 'hoe.dating', action: 'other' }
  ]) {
    const f = await fixture(t, { verification });
    assert.equal((await f.submit(await f.form())).status, 400);
    assert.equal(mailCalls(f.calls).length, 0);
    await assert.rejects(readFile(join(f.directory, 'waitlist.json')), { code: 'ENOENT' });
  }
});

test('spam trap quietly discards bot submissions', async t => {
  const f = await fixture(t);
  assert.equal((await f.submit(await f.form(), { website: 'https://spam.example' })).status, 200);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(join(f.directory, 'waitlist.json')), { code: 'ENOENT' });
});

test('invalid email, header injection and missing consent are rejected', async t => {
  for (const fields of [
    { email: 'wrong' }, { email: 'a@b.com\r\nBcc:spam@example.com' },
    { email: 'a..b@example.com' }, { email: 'a@-example.com' }, { consent: false }
  ]) {
    const f = await fixture(t);
    assert.equal((await f.submit(await f.form(), fields)).status, 400);
    assert.equal(f.calls.length, 0);
  }
});

test('wrong origin, tampered nonce, missing cookie and expired forms are rejected', async t => {
  const f = await fixture(t);
  const state = await f.form();
  assert.equal((await f.submit(state, {}, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.submit(state, { nonce: state.nonce + 'tampered' })).status, 400);
  assert.equal((await f.submit(state, {}, { Cookie: '' })).status, 400);
  f.advance(31 * 60000);
  assert.equal((await f.submit(state)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('instant automated submission is rejected but a normal delayed submission succeeds', async t => {
  const f = await fixture(t, { minFormAge: 2000 });
  const state = await f.form();
  assert.equal((await f.submit(state)).status, 400);
  f.advance(2500);
  assert.equal((await f.submit(state)).status, 200);
});

test('large payloads and unsupported content types/methods are rejected', async t => {
  const f = await fixture(t);
  const state = await f.form();
  assert.equal((await f.submit(state, { padding: 'x'.repeat(5000) })).status, 413);
  assert.equal((await f.submit(state, {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(f.url + '/api/waitlist')).status, 405);
  assert.equal(f.calls.length, 0);
});

test('per-session rate limit and persistent daily mail cap prevent inbox flooding', async t => {
  const f = await fixture(t, { config: { dailyLimit: 1 } });
  const state = await f.form();
  assert.equal((await f.submit(state)).status, 200);
  assert.equal((await f.submit(state, { email: 'second@example.com' })).status, 429);
  for (let i = 0; i < 3; i++) await f.submit(state);
  assert.equal((await f.submit(state)).status, 429);
  assert.equal(mailCalls(f.calls).length, 1);
  assert.equal((await records(f.directory)).length, 1);
});

test('uncertain delivery is persisted without automatic resend on duplicate signup', async t => {
  const f = await fixture(t, { mailFails: true });
  const state = await f.form();
  assert.equal((await f.submit(state)).status, 200);
  assert.equal((await records(f.directory))[0].confirmation.attempts[0].status, 'uncertain');
  assert.equal((await f.submit(state)).status, 200);
  assert.equal(mailCalls(f.calls).length, 1);
});

test('unwritable storage prevents sending rather than losing the signup', async t => {
  const f = await fixture(t);
  const state = await f.form();
  await rm(f.directory, { recursive: true, force: true });
  await writeFile(f.directory, 'Storage unavailable');
  assert.equal((await f.submit(state)).status, 503);
  assert.equal(mailCalls(f.calls).length, 0);
});

test('persisted signups remain deduplicated after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hoe-restart-list-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await fixture(t, { directory });
  await first.submit(await first.form());
  await new Promise(resolve => { first.server.close(resolve); first.server.closeAllConnections(); });
  const next = await fixture(t, { directory });
  assert.equal((await next.submit(await next.form())).status, 200);
  assert.equal(mailCalls(next.calls).length, 0);
});

test('security policy and served scripts allow the intended widget and no private implementation', async t => {
  const f = await fixture(t);
  const page = await fetch(f.url);
  const policy = page.headers.get('content-security-policy');
  assert.match(policy, /script-src 'self' https:\/\/challenges.cloudflare.com/);
  assert.match(policy, /frame-src https:\/\/challenges.cloudflare.com/);
  const script = await fetch(f.url + '/site.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const body = await script.text();
  assert.doesNotMatch(body, /private-mail-token|private-bot-secret/);
  assert.equal((await fetch(f.url + '/waitlist.mjs')).status, 404);
});

test('corrupt private waitlist data fails startup rather than erasing existing subscribers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hoe-corrupt-list-'));
  try {
    await writeFile(join(directory, 'waitlist.json'), '{"not":"a list"}');
    await assert.rejects(createApp({ dataDir: directory }), /Invalid waitlist data/);
    assert.equal(await readFile(join(directory, 'waitlist.json'), 'utf8'), '{"not":"a list"}');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('global submission limit also covers fresh browser sessions', async t => {
  const f = await fixture(t, { verification: { success: false } });
  for (let index = 0; index < 30; index++) {
    const state = await f.form();
    assert.equal((await f.submit(state)).status, 400);
  }
  assert.equal((await f.submit(await f.form())).status, 429);
  assert.equal(mailCalls(f.calls).length, 0);
});

test('expired and tampered confirmation links cannot verify or notify', async t => {
  const f = await fixture(t);
  await f.submit(await f.form());
  const token = confirmationToken(f.calls);
  const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
  assert.equal((await f.confirm(tampered)).status, 400);
  assert.equal((await fetch(f.url + '/confirm?token=' + encodeURIComponent('<script>alert(1)</script>'))).status, 400);
  f.advance(24 * 60 * 60000);
  assert.equal((await f.confirm(token)).status, 400);
  assert.equal((await fetch(f.url + '/confirm?token=' + token)).status, 400);
  assert.equal((await records(f.directory))[0].verifiedAt, null);
  assert.equal(mailCalls(f.calls).length, 1);
});

test('confirmation POST requires the canonical origin and a bounded form body', async t => {
  const f = await fixture(t);
  await f.submit(await f.form());
  const token = confirmationToken(f.calls);
  assert.equal((await f.confirm(token, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.confirm(token, { Origin: '' })).status, 403);
  assert.equal((await f.confirm(token, { 'Content-Type': 'text/plain' })).status, 415);
  const large = await fetch(f.url + '/confirm', { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded', Origin: configuration.origin
  }, body: 'token=' + 'x'.repeat(5000) });
  assert.equal(large.status, 413);
  const duplicate = await fetch(f.url + '/confirm', { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded', Origin: configuration.origin
  }, body: new URLSearchParams([['token', token], ['token', token]]) });
  assert.equal(duplicate.status, 400);
  assert.equal((await fetch(f.url + '/confirm?token=' + token, { method: 'PUT' })).status, 405);
  assert.equal((await records(f.directory))[0].verifiedAt, null);
  assert.equal(mailCalls(f.calls).length, 1);
});

test('confirmation tokens survive restart but team notice and verification cannot replay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hoe-confirm-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await fixture(t, { directory });
  await first.submit(await first.form());
  const token = confirmationToken(first.calls);
  await new Promise(resolve => { first.server.close(resolve); first.server.closeAllConnections(); });
  const next = await fixture(t, { directory });
  assert.equal((await next.confirm(token)).status, 200);
  assert.equal(mailCalls(next.calls).length, 1);
  await new Promise(resolve => { next.server.close(resolve); next.server.closeAllConnections(); });
  const third = await fixture(t, { directory });
  assert.equal((await third.confirm(token)).status, 200);
  assert.equal(mailCalls(third.calls).length, 0);
});

test('explicit resubmission allows a bounded resend after cooldown and invalidates the old token', async t => {
  const f = await fixture(t, { mailFails: true });
  await f.submit(await f.form());
  const original = confirmationToken(f.calls);
  assert.equal((await f.submit(await f.form())).status, 200);
  assert.equal(mailCalls(f.calls).length, 1);
  f.advance(15 * 60000);
  await f.submit(await f.form());
  assert.equal(mailCalls(f.calls).length, 2);
  assert.equal((await f.confirm(original)).status, 400);
  f.advance(15 * 60000);
  await f.submit(await f.form());
  f.advance(15 * 60000);
  await f.submit(await f.form());
  assert.equal(mailCalls(f.calls).length, 3);
  const entry = (await records(f.directory))[0];
  assert.equal(entry.confirmation.attempts.length, 3);
  assert.ok(entry.confirmation.attempts.every(attempt => attempt.status === 'uncertain'));
});

test('persistent daily cap limits confirmation sends but never blocks a valid confirmation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hoe-confirm-cap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await fixture(t, { directory, config: { dailyLimit: 1 } });
  await first.submit(await first.form());
  const token = confirmationToken(first.calls);
  await new Promise(resolve => { first.server.close(resolve); first.server.closeAllConnections(); });
  const next = await fixture(t, { directory, config: { dailyLimit: 1 } });
  assert.equal((await next.submit(await next.form(), { email: 'second@example.com' })).status, 429);
  assert.equal((await next.confirm(token)).status, 200);
  assert.equal(mailCalls(next.calls).length, 1);
  assert.deepEqual(JSON.parse(mailCalls(next.calls)[0].init.body).to, ['connect@feyros.com']);
});

test('legacy signups remain unverified until they explicitly request and complete confirmation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hoe-legacy-confirm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = { id: 'legacy-id', email: 'person@example.com', joinedAt: '2026-10-01T00:00:00Z',
    consentAt: '2026-10-01T00:00:00Z', consent: 'hoe-launch-updates-v1',
    attemptedAt: '2026-10-01T00:00:00Z', notification: 'sent' };
  await writeFile(join(directory, 'waitlist.json'), JSON.stringify([legacy]));
  const f = await fixture(t, { directory });
  assert.equal(mailCalls(f.calls).length, 0);
  assert.deepEqual(await records(directory), [legacy]);
  await f.submit(await f.form());
  const pending = (await records(directory))[0];
  assert.equal(pending.verifiedAt, null);
  assert.equal(pending.legacyNotification.status, 'sent');
  assert.equal(pending.joinedAt, legacy.joinedAt);
  assert.deepEqual(JSON.parse(mailCalls(f.calls)[0].init.body).to, ['person@example.com']);
  await f.confirm(confirmationToken(f.calls));
  assert.equal(mailCalls(f.calls).length, 2);
  assert.equal((await records(directory))[0].notification, 'sent');
});

test('ambiguous team delivery is recorded once and never automatically retried', async t => {
  const f = await fixture(t, { teamMailFails: true });
  await f.submit(await f.form());
  const token = confirmationToken(f.calls);
  assert.equal((await f.confirm(token)).status, 200);
  const entry = (await records(f.directory))[0];
  assert.ok(entry.verifiedAt);
  assert.equal(entry.notification, 'uncertain');
  assert.equal((await f.confirm(token)).status, 200);
  assert.equal(mailCalls(f.calls).length, 2);
});

test('corrupt confirmation hashes fail startup without overwriting storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hoe-corrupt-confirm-'));
  const text = JSON.stringify([{ version: 2, id: 'id', email: 'person@example.com', joinedAt: '2026-10-08T12:00:00Z',
    verifiedAt: null, notification: 'pending', confirmation: { hash: 'raw-token', expiresAt: '2026-10-09T12:00:00Z',
      attempts: [{ attemptedAt: '2026-10-08T12:00:00Z', status: 'sent' }] } }]);
  try {
    await writeFile(join(directory, 'waitlist.json'), text);
    await assert.rejects(createApp({ dataDir: directory }), /Invalid waitlist data/);
    assert.equal(await readFile(join(directory, 'waitlist.json'), 'utf8'), text);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
