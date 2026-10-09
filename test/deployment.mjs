// Read-only diagnostics. Never log configuration bodies, tokens or subscriber data.
const origin = 'https://hoe.dating';
async function check(path, inspect) {
  try {
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    const body = await response.text();
    return { status: response.status, ...inspect(response, body) };
  } catch (error) {
    return { reachable: false, reason: error.cause?.code || error.name };
  }
}
let liveReady = false;
for (let attempt = 1; attempt <= 6; attempt++) {
  const [page, health, config, script, confirmation] = await Promise.all([
    check('/', (_, body) => ({ latestScript: body.includes('/site.js?v=20261009-2'), renderedCountdown: /id="days">\d+<\/strong>/.test(body) })),
    check('/health', (_, body) => { try { return { healthy: JSON.parse(body).status === 'ok' }; } catch { return { healthy: false }; } }),
    check('/api/public-config', (_, body) => {
      try {
        const value = JSON.parse(body);
        return { validConfig: typeof value.launchAt === 'string', waitlistAvailable: value.waitlist?.available === true };
      } catch { return { validConfig: false, waitlistAvailable: false }; }
    }),
    check('/site.js?v=20261009-2', (response, body) => ({
      javascriptType: /javascript/.test(response.headers.get('content-type') || ''),
      expectedScript: body.includes("appearance: 'interaction-only'")
    })),
    check('/confirm?token=' + 'x'.repeat(43), (response, body) => ({
      handled: response.status === 400 && body.includes('This confirmation link is invalid'),
      tokenSafeReferrers: response.headers.get('referrer-policy') === 'strict-origin',
      noReflectedToken: !body.includes('x'.repeat(43))
    }))
  ]);
  console.log(JSON.stringify({ attempt, page, health, config, script, confirmation }));
  if (page.latestScript && page.renderedCountdown && health.healthy && config.validConfig && config.waitlistAvailable && script.javascriptType && script.expectedScript && confirmation.handled && confirmation.tokenSafeReferrers && confirmation.noReflectedToken) {
    liveReady = true;
    console.log('LIVE_READY: current page, countdown markup, Node API, enabled waitlist configuration, browser asset and confirmation endpoint verified.');
    break;
  }
  if (attempt === 6) console.log('LIVE_NEEDS_REVIEW: read-only diagnostics above identify the deployment or configuration that still needs attention.');
  else await new Promise(resolve => setTimeout(resolve, 10000));
}

if (liveReady) {
  const { chromium } = await import('../.ci-runtime/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => /^\d+$/.test(document.querySelector('#days')?.textContent || ''));
    const first = await page.locator('#seconds').innerText();
    await page.waitForFunction(value => document.querySelector('#seconds').textContent !== value, first);
    await page.waitForFunction(() => !/Checking waitlist availability/.test(document.querySelector('#waitlist-message').textContent));
    // Allow the minimum form age and managed challenge to finish; automated browsers may still require an interactive check.
    await page.waitForFunction(() => !document.querySelector('.join').disabled, null, { timeout: 12000 }).catch(() => {});
    const status = await page.locator('#waitlist-message').innerText();
    await page.screenshot({ path: 'artifacts/hoe-live-mobile.png', fullPage: true });
    console.log(JSON.stringify({ liveBrowser: true, countdownTicking: true,
      startupFinished: true, waitlistButtonEnabled: !(await page.locator('.join').isDisabled()),
      waitlistStatus: status, securityWidgetPresent: page.frames().some(frame => frame.url().startsWith('https://challenges.cloudflare.com/')),
      pageErrorCount: errors.length }));
    if (errors.length) throw new Error('Live page has browser script errors.');
  } finally { await browser.close(); }
}
