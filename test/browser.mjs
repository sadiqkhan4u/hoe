import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as reserveServer } from 'node:net';
import { chromium } from '../.ci-runtime/node_modules/playwright/index.mjs';
import { createApp } from '../dist/app.mjs';

const directory = await mkdtemp(join(tmpdir(), 'hoe-browser-'));
const server = await createApp({ dataDir: directory, secureCookies: false });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true });
await mkdir('artifacts', { recursive: true });
try {
  for (const viewport of [{ width: 1280, height: 1000 }, { width: 320, height: 900 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.locator('#days').filter({ hasText: /^\d+$/ }).waitFor();
    assert.match(await page.locator('#launch-date').innerText(), /December 25, 2026/);
    assert.equal(await page.locator('.join').isDisabled(), true);
    await page.locator('#waitlist-message').filter({ hasText: /opens soon/ }).waitFor();
    assert.equal(await page.locator('.logo').evaluate(img => img.complete && img.naturalWidth === 1774), true);
    const layout = await page.locator('.logo').evaluate(img => ({
      width: img.getBoundingClientRect().width,
      blend: getComputedStyle(img).mixBlendMode,
      overflow: document.documentElement.scrollWidth > window.innerWidth
    }));
    assert.ok(layout.width <= 230 && layout.width >= 170);
    assert.equal(layout.blend, 'screen');
    assert.equal(layout.overflow, false, JSON.stringify(await page.evaluate(() =>
      [...document.querySelectorAll('body *')].map(element => {
        const rect = element.getBoundingClientRect();
        return { element: element.tagName, class: element.className, right: rect.right, width: rect.width };
      }).filter(item => item.right > innerWidth + 1)
    )));
    assert.equal(await page.locator('text=Filmymantra').count(), 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'artifacts/hoe-' + viewport.width + '.png', fullPage: true });
    console.log('Countdown, compact logo and unavailable state verified at ' + viewport.width + 'px.');
    await page.close();
  }

  // A stalled configuration request must not stop the countdown or leave "checking" forever.
  for (const failure of ['stalled', 'html', 'empty-json', 'bad-deadline']) {
    const page = await browser.newPage({ viewport: { width: 393, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/public-config', async route => {
      if (failure === 'html') return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' });
      if (failure === 'empty-json') return route.fulfill({ json: {} });
      if (failure === 'bad-deadline') return route.fulfill({ json: { launchAt: 'not-a-date', serverTime: Date.now(), waitlist: { available: false } } });
      // Holding the route simulates a connection that never answers.
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const first = await page.locator('#seconds').innerText();
    await page.waitForFunction(value => document.querySelector('#seconds').textContent !== value, first);
    await page.locator('#waitlist-message').filter({ hasText: /temporarily unavailable/ }).waitFor();
    assert.equal(await page.locator('.join').isDisabled(), true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'artifacts/hoe-' + failure + '.png', fullPage: true });
    console.log('Countdown stays live and signup fails closed for ' + failure + ' configuration.');
    await page.close();
  }
  const noScript = await browser.newPage({ javaScriptEnabled: false });
  await noScript.goto(url);
  assert.match(await noScript.locator('#days').innerText(), /^\d+$/);
  assert.match(await noScript.locator('noscript').innerText(), /Enable JavaScript/);
  await noScript.close();

  const page = await browser.newPage({ viewport: { width: 393, height: 1000 } });
  const requests = [];
  await page.route('**/api/public-config', route => route.fulfill({ json: {
    launchAt: '2026-12-25T08:00:00.000Z', serverTime: Date.now(),
    waitlist: { available: true, siteKey: 'browser-test-key' }
  } }));
  await page.route('**/api/waitlist-form', route => route.fulfill({ json: {
    available: true, siteKey: 'browser-test-key', nonce: 'browser-nonce'
  } }));
  await page.route('https://challenges.cloudflare.com/**', route => route.fulfill({
    contentType: 'text/javascript',
    body: "window.turnstile={render:(id,options)=>{window.testWidgetOptions={size:options.size,appearance:options.appearance};setTimeout(()=>options.callback('browser-token'),10);return 1;},reset:()=>{}};"
  }));
  await page.route('**/api/waitlist', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { message: "Check your inbox for a confirmation link. Confirm your email to join the waitlist." } });
  });
  await page.goto(url);
  await page.locator('input[name=email]').fill('test@example.com');
  await page.locator('input[name=consent]').check();
  await page.waitForFunction(() => !document.querySelector('.join').disabled);
  assert.deepEqual(await page.evaluate(() => window.testWidgetOptions), { size: 'normal', appearance: 'interaction-only' });
  assert.equal(await page.locator('.protection-note svg').count(), 1);
  await page.locator('.join').click();
  await page.locator('#waitlist-message').filter({ hasText: "Check your inbox" }).waitFor();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { email: 'test@example.com', consent: true,
    website: '', nonce: 'browser-nonce', turnstileToken: 'browser-token' });
  assert.equal(await page.locator('#waitlist-form').isHidden(), true);
  console.log('Configured form submission and accessible success state verified.');

  // Real confirmation routes, with mail and bot providers stubbed to avoid contacting anyone.
  const reservation = reserveServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const confirmationOrigin = 'http://127.0.0.1:' + port;
  const confirmationDirectory = join(directory, 'confirmation');
  const mails = [];
  const confirmationServer = await createApp({
    dataDir: confirmationDirectory, secureCookies: false,
    waitlistOptions: { minFormAge: 0, config: {
      origin: confirmationOrigin, siteKey: 'browser-test-key', turnstileSecret: 'test-secret',
      mailToken: 'test-mail-token', mailboxId: 'ACtestMailbox', dailyLimit: 100
    }, fetchImpl: async (url, init) => {
      if (url.includes('siteverify')) return new Response(JSON.stringify({
        success: true, hostname: '127.0.0.1', action: 'waitlist'
      }));
      mails.push(JSON.parse(init.body));
      return new Response('{}');
    } }
  });
  await new Promise(resolve => confirmationServer.listen(port, '127.0.0.1', resolve));
  try {
    const stateResponse = await fetch(confirmationOrigin + '/api/waitlist-form');
    const state = await stateResponse.json();
    const signup = await fetch(confirmationOrigin + '/api/waitlist', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: confirmationOrigin,
        Cookie: stateResponse.headers.get('set-cookie').split(';')[0] },
      body: JSON.stringify({ email: 'browser@example.com', consent: true, website: '',
        nonce: state.nonce, turnstileToken: 'test-token' })
    });
    assert.equal(signup.status, 200);
    assert.deepEqual(mails[0].to, ['browser@example.com']);
    const token = mails[0].text.match(/token=([A-Za-z0-9_-]{43})/)[1];
    const confirmationPage = await browser.newPage({ viewport: { width: 320, height: 900 } });
    await confirmationPage.goto(confirmationOrigin + '/confirm?token=' + token);
    assert.equal(JSON.parse(await readFile(join(confirmationDirectory, 'waitlist.json'), 'utf8'))[0].verifiedAt, null);
    assert.equal(mails.length, 1);
    assert.equal(await confirmationPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await confirmationPage.getByRole('button', { name: 'Confirm my email' }).click();
    await confirmationPage.locator('p').filter({ hasText: /email is confirmed/i }).waitFor();
    assert.equal(mails.length, 2);
    assert.deepEqual(mails[1].to, ['connect@feyros.com']);
    assert.ok(JSON.parse(await readFile(join(confirmationDirectory, 'waitlist.json'), 'utf8'))[0].verifiedAt);
    await confirmationPage.screenshot({ path: 'artifacts/hoe-confirmed-mobile.png', fullPage: true });
    await confirmationPage.close();
    console.log('Scanner-safe confirmation page and real native confirmation POST verified at 320px.');
  } finally {
    await new Promise(resolve => { confirmationServer.close(resolve); confirmationServer.closeAllConnections(); });
  }
} finally {
  await browser.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await rm(directory, { recursive: true, force: true });
}
