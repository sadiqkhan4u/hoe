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
for (let attempt = 1; attempt <= 6; attempt++) {
  const [page, health, config, script] = await Promise.all([
    check('/', (_, body) => ({ latestScript: body.includes('/site.js?v=20261009-1'), renderedCountdown: /id="days">\d+<\/strong>/.test(body) })),
    check('/health', (_, body) => { try { return { healthy: JSON.parse(body).status === 'ok' }; } catch { return { healthy: false }; } }),
    check('/api/public-config', (_, body) => {
      try {
        const value = JSON.parse(body);
        return { validConfig: typeof value.launchAt === 'string', waitlistAvailable: value.waitlist?.available === true };
      } catch { return { validConfig: false, waitlistAvailable: false }; }
    }),
    check('/site.js?v=20261009-1', (response, body) => ({
      javascriptType: /javascript/.test(response.headers.get('content-type') || ''),
      expectedScript: body.includes("startCountdown(date.dateTime || null")
    }))
  ]);
  console.log(JSON.stringify({ attempt, page, health, config, script }));
  if (page.latestScript && page.renderedCountdown && health.healthy && config.validConfig && config.waitlistAvailable && script.javascriptType && script.expectedScript) {
    console.log('LIVE_READY: current page, countdown markup, Node API, enabled waitlist configuration and browser asset verified.');
    break;
  }
  if (attempt === 6) console.log('LIVE_NEEDS_REVIEW: read-only diagnostics above identify the deployment or configuration that still needs attention.');
  else await new Promise(resolve => setTimeout(resolve, 10000));
}
