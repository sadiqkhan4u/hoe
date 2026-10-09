import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    body: "window.turnstile={render:(id,options)=>{setTimeout(()=>options.callback('browser-token'),10);return 1;},reset:()=>{}};"
  }));
  await page.route('**/api/waitlist', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { message: "You're on the list. We'll let you know when HOE is ready." } });
  });
  await page.goto(url);
  await page.locator('input[name=email]').fill('test@example.com');
  await page.locator('input[name=consent]').check();
  await page.waitForFunction(() => !document.querySelector('.join').disabled);
  await page.locator('.join').click();
  await page.locator('#waitlist-message').filter({ hasText: "You're on the list" }).waitFor();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { email: 'test@example.com', consent: true,
    website: '', nonce: 'browser-nonce', turnstileToken: 'browser-token' });
  assert.equal(await page.locator('#waitlist-form').isHidden(), true);
  console.log('Configured form submission and accessible success state verified.');
} finally {
  await browser.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await rm(directory, { recursive: true, force: true });
}
