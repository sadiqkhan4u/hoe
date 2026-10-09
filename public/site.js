(() => {
'use strict';
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

function parseLaunchAt(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('Launch date must be a timestamp.');
  const text = value.trim();
  if (!text) return null;
  const match = ISO.exec(text);
  if (!match) throw new RangeError('Launch date must include an explicit timezone.');
  const [, ys, mos, ds, hs, mins, ss = '0', , zone, , zhs = '0', zms = '0'] = match;
  const [y, mo, d, h, min, s, zh, zm] = [ys, mos, ds, hs, mins, ss, zhs, zms].map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] || h > 23 || min > 59 || s > 59 ||
      (zone !== 'Z' && (zh > 14 || zm > 59 || (zh === 14 && zm !== 0)))) {
    throw new RangeError('Launch date contains an invalid date, time, or UTC offset.');
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new RangeError('Invalid launch date.');
  return new Date(timestamp).toISOString();
}

function countdownParts(launchAt, now = Date.now()) {
  const iso = parseLaunchAt(launchAt);
  if (iso === null) return null;
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new TypeError('Current time must be finite.');
  const difference = Date.parse(iso) - now;
  const total = Math.floor(Math.max(0, difference) / 1000);
  return {
    days: Math.floor(total / 86400), hours: Math.floor(total / 3600) % 24,
    minutes: Math.floor(total / 60) % 60, seconds: total % 60, complete: difference <= 0
  };
}


const form = document.querySelector('#waitlist-form');
const button = form.querySelector('button');
const message = document.querySelector('#waitlist-message');
let nonce = null;
let widgetId = null;
let token = '';
let oldEnough = false;
let busy = false;
let config;
let countdownTimer;
let formAgeTimer;
const unavailable = 'The waitlist is temporarily unavailable. Please try again shortly.';
async function fetchJSON(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || unavailable);
    return result;
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof SyntaxError || error instanceof TypeError) throw new Error(unavailable);
    throw error;
  } finally { clearTimeout(timeout); }
}
function updateButton() { button.disabled = busy || !oldEnough || !token || !nonce || !config?.waitlist?.available; }
function resetChallenge() {
  token = '';
  if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
  updateButton();
}
async function refreshForm() {
  oldEnough = false;
  nonce = null;
  clearTimeout(formAgeTimer);
  updateButton();
  const state = await fetchJSON('/api/waitlist-form', { cache: 'no-store' });
  if (typeof state.nonce !== 'string' || !state.nonce) throw new Error(unavailable);
  nonce = state.nonce;
  if (!state.available) throw new Error('The waitlist opens soon. Please check back.');
  formAgeTimer = setTimeout(() => { oldEnough = true; updateButton(); }, 2100);
}
function loadChallenge(siteKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    const timeout = setTimeout(() => {
      script.remove();
      reject(new Error('The security check could not load. Please refresh and try again.'));
    }, 8000);
    script.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('The security check could not load. Please refresh and try again.'));
    };
    script.onload = () => {
      clearTimeout(timeout);
      try {
        widgetId = window.turnstile.render('#bot-check', {
          sitekey: siteKey, action: 'waitlist', theme: 'dark', size: window.matchMedia('(min-width: 360px)').matches ? 'normal' : 'compact', appearance: 'interaction-only',
          callback: value => { if (form.hidden) return; token = value; updateButton(); message.textContent = ''; },
          'expired-callback': () => { if (form.hidden) return; token = ''; updateButton(); message.textContent = 'Please complete the security check again.'; },
          'error-callback': () => { if (form.hidden) return; token = ''; updateButton(); message.textContent = 'Please refresh to retry the security check.'; }
        });
        resolve();
      } catch { reject(new Error('The security check could not start. Please try again later.')); }
    };
    document.head.append(script);
  });
}
function startCountdown(launchAt, serverTime) {
  launchAt = parseLaunchAt(launchAt);
  clearInterval(countdownTimer);
  const clockOffset = Number.isFinite(serverTime) ? serverTime - Date.now() : 0;
  const label = document.querySelector('#countdown-label');
  const date = document.querySelector('#launch-date');
  if (!launchAt) {
    label.textContent = 'Launch date coming soon';
    date.textContent = 'Something good is on its way.';
    return;
  }
  label.textContent = 'Launching in';
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
    countdownTimer = setInterval(() => { if (tick()) clearInterval(countdownTimer); }, 1000);
  }
}
function showConfirmationMessage(text) {
  const blocks = String(text).split(/\n\s*\n/);
  const heading = document.createElement('h2');
  heading.textContent = blocks.shift();
  const paragraphs = blocks.map((block, index) => {
    const paragraph = document.createElement('p');
    paragraph.textContent = block;
    paragraph.className = ['confirmation-intro', 'confirmation-action', 'confirmation-wink', 'confirmation-note'][index] || '';
    return paragraph;
  });
  message.replaceChildren(heading, ...paragraphs);
  message.classList.add('success');
  message.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start'
  });
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled || busy) return;
  busy = true;
  updateButton();
  button.textContent = 'Joining…';
  message.textContent = '';
  try {
    const result = await fetchJSON('/api/waitlist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: form.elements.email.value, consent: form.elements.consent.checked,
        website: form.elements.website.value, nonce, turnstileToken: token
      })
    }, 25000);

    showConfirmationMessage(result.message);
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

const date = document.querySelector('#launch-date');
startCountdown(date.dateTime || null, Number(date.dataset.serverTime));
message.textContent = 'Checking waitlist availability…';
(async () => {
try {
  const incoming = await fetchJSON('/api/public-config', { cache: 'no-store' });
  if (!incoming || !Object.prototype.hasOwnProperty.call(incoming, 'launchAt') ||
      !Number.isFinite(incoming.serverTime) || typeof incoming.waitlist?.available !== 'boolean' ||
      (incoming.waitlist.available && (typeof incoming.waitlist.siteKey !== 'string' || !incoming.waitlist.siteKey))) throw new Error(unavailable);
  try { parseLaunchAt(incoming.launchAt); } catch { throw new Error(unavailable); }
  config = incoming;
  startCountdown(config.launchAt, config.serverTime);
  if (config.waitlist.available) {
    await refreshForm();
    message.textContent = 'Preparing the security check…';
    await loadChallenge(config.waitlist.siteKey);
    if (!token) message.textContent = 'Complete the security check to join the waitlist.';
  } else {
    message.textContent = 'The waitlist opens soon. Please check back.';
  }
} catch (error) {
  message.textContent = error.message || unavailable;
  updateButton();
}
})();

})();
