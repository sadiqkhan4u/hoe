# Countdown and verified launch waitlist

The launch is December 25, 2026 at 00:00 PST (2026-12-25T08:00:00Z). LAUNCH_AT accepts an ISO timestamp with timezone.

## Hostinger settings

Use NODE_ENV=production and APP_ORIGIN=https://hoe.dating. The existing credentials support both subscriber confirmation and verified team notifications. No new service or key is needed.

- TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY: Managed Cloudflare widget for hoe.dating.
- HOSTINGER_MAIL_API_TOKEN: private Mail API token for the order containing connect@feyros.com.
- HOSTINGER_MAILBOX_ID: private resourceId of that mailbox, obtainable through Mail API GET /api/v1/me. Never publish account identifiers.
- COUNTER_DATA_DIR: writable persistent directory outside deployment builds.
- WAITLIST_DAILY_LIMIT: default 100 confirmation-email attempts per UTC day, persisted across restarts. Confirmed signups can generate one additional team notification each.

Save variables in the website dashboard, Apply changes, and deploy latest main. Never paste secrets into chat, screenshots or GitHub.

## Email ownership confirmation

1. Visitor enters an email, agrees to launch updates and passes server-validated Turnstile.
2. The app stores a pending signup and sends a confirmation link to that address from the configured mailbox.
3. The link opens a page with a Confirm my email button. GET/HEAD requests never verify a signup, avoiding accidental confirmation by link scanners.
4. An explicit confirmation POST consumes the action, records verifiedAt, then notifies connect@feyros.com with a verified signup.
5. Only records with verifiedAt belong in the confirmed launch mailing list.

Links expire in 24 hours. A random 256-bit token is emailed; only its SHA-256 hash is stored privately. Replay cannot trigger another notification. The confirmation page uses strict-origin referrers, which omit paths/query strings and keep the token out of referrers, and has no third-party assets. This also keeps the browser's native form Origin compatible with exact canonical Origin checks.

Existing records remain unchanged and unverified on startup. Their owners can submit again to receive a confirmation. No bulk mail or retroactive verification is performed. A migrated legacy signup preserves its original notification history.

## Resends and uncertain delivery

A new form submission can resend a pending confirmation after 15 minutes, at most three attempts per address per rolling 24 hours. This replaces the prior token. Confirmed duplicate signups do not generate additional mail.

Send claims are saved before contacting the provider. Sending/uncertain status requires private review; the provider may already have accepted the request. There are no automatic mail retries.

## Spam safeguards

Server-side Turnstile hostname/action verification, signed cookie-bound form nonce, minimum form age, matching Origin, small bounded payloads, strict email validation, explicit consent, honeypot, per-session/global limits and persistent confirmation-mail caps remain active.

Cloudflare has no icon-size widget. A small shield/protection label is shown, while the genuine challenge appears only if interaction is needed. Wider screens use native normal size 300×65; narrow screens use compact 150×140. The challenge is not cropped or scaled.

Confirmation proves access to the inbox at that time. It does not establish real-world identity, reject all disposable addresses or determine whether someone is honest. Keep bot checks and rate limits.

## Private data and validation

waitlist.json remains private with atomic serialized writes for one Node process. Back it up before manual removal or repairs. Honor removal requests at connect@feyros.com. Filter launch contacts by verifiedAt, excluding all pending/legacy records. Migrate to a transactional shared database before adding multiple processes or replicas.

CI tests token hashing, expiry/replay, scanner-safe GET, confirmation POST, duplicates, resends, storage failure, legacy/restart behavior and mail limits with provider mocks. Browser tests cover desktop/mobile signup and confirmation. Live checks never submit an address or send email; test actual inbox delivery yourself with an address you control.

References:
- [Cloudflare widget options](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/)
- [Cloudflare server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Confirmation-based signup](https://mailchimp.com/help/about-double-opt-in/)
- [Hostinger Mail API](https://api.mail.hostinger.com)
