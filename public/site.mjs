import { countdownParts } from './countdown.mjs';

const form = document.querySelector('#waitlist-form');
const button = form.querySelector('button');
const message = document.querySelector('#waitlist-message');
let nonce = null;
let widgetId = null;
let token = '';
let oldEnough = false;
let busy = false;
let config;
function updateButton() { button.disabled = busy || !oldEnough || !token || !config?.waitlist.available; }
function resetChallenge() {
  token = '';
  if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
  updateButton();
}
async function refreshForm() {
  oldEnough = false;
  updateButton();
  const response = await fetch('/api/waitlist-form', { cache: 'no-store' });
  if (!response.ok) throw new Error('The waitlist is temporarily unavailable.');
  const state = await response.json();
  nonce = state.nonce;
  if (!state.available) throw new Error('The waitlist opens soon. Please check back.');
  setTimeout(() => { oldEnough = true; updateButton(); }, 2100);
}
function loadChallenge(siteKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onerror = () => reject(new Error('The security check could not load. Please refresh and try again.'));
    script.onload = () => {
      try {
        widgetId = window.turnstile.render('#bot-check', {
          sitekey: siteKey, action: 'waitlist', theme: 'dark', size: 'compact', appearance: 'interaction-only',
          callback: value => { token = value; updateButton(); },
          'expired-callback': () => { token = ''; updateButton(); },
          'error-callback': () => { token = ''; updateButton(); message.textContent = 'Please refresh to retry the security check.'; }
        });
        resolve();
      } catch { reject(new Error('The security check could not start. Please try again later.')); }
    };
    document.head.append(script);
  });
}
function startCountdown(launchAt, serverTime) {
  const clockOffset = serverTime - Date.now();
  const label = document.querySelector('#countdown-label');
  const date = document.querySelector('#launch-date');
  if (!launchAt) {
    label.textContent = 'Launch date coming soon';
    date.textContent = 'Something good is on its way.';
    return;
  }
  date.dateTime = launchAt;
  date.textContent = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).format(new Date(launchAt));
  function tick() {
    const parts = countdownParts(launchAt, Date.now() + clockOffset);
    for (const unit of ['days', 'hours', 'minutes', 'seconds']) {
      document.querySelector('#' + unit).textContent = String(parts[unit]).padStart(2, '0');
    }
    if (parts.complete) {
      label.textContent = 'Launch updates coming soon';
      return true;
    }
    return false;
  }
  if (!tick()) {
    const timer = setInterval(() => { if (tick()) clearInterval(timer); }, 1000);
  }
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled || busy) return;
  busy = true;
  updateButton();
  button.textContent = 'Joining…';
  message.textContent = '';
  try {
    const response = await fetch('/api/waitlist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: form.elements.email.value, consent: form.elements.consent.checked,
        website: form.elements.website.value, nonce, turnstileToken: token
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Please try again shortly.');
    message.textContent = result.message;
    message.classList.add('success');
    form.hidden = true;
    document.querySelector('#bot-check').hidden = true;
  } catch (error) {
    message.textContent = error.message || 'Please check your connection and try again.';
    try { await refreshForm(); } catch (refreshError) { message.textContent = refreshError.message; }
    resetChallenge();
  } finally {
    busy = false;
    button.textContent = 'Join Waitlist →';
    updateButton();
  }
});

try {
  const response = await fetch('/api/public-config', { cache: 'no-store' });
  if (!response.ok) throw new Error('Please refresh to check for updates.');
  config = await response.json();
  startCountdown(config.launchAt, config.serverTime);
  if (config.waitlist.available) {
    await refreshForm();
    await loadChallenge(config.waitlist.siteKey);
    message.textContent = '';
  } else {
    message.textContent = 'The waitlist opens soon. Please check back.';
  }
} catch (error) {
  message.textContent = error.message || 'Please refresh to check for updates.';
}
