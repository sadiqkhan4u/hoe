# Countdown and protected launch waitlist

The default launch is **December 25, 2026 at 00:00 PST**, equivalent to **2026-12-25T08:00:00Z**. Override LAUNCH_AT only with an ISO timestamp including a timezone.

## Activate the form in Hostinger

Keep NODE_ENV=production and APP_ORIGIN=https://hoe.dating.

1. In Cloudflare Turnstile, create a managed widget named HOE Waitlist for hostname hoe.dating.
2. Add TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY to Hostinger environment variables.
3. Generate a separate Hostinger Mail API key for the mail order containing connect@feyros.com. The app cannot reuse this chat's connector credentials.
4. Add HOSTINGER_MAIL_API_TOKEN privately in Hostinger.
5. Set HOSTINGER_MAILBOX_ID privately in Hostinger to the resourceId of connect@feyros.com. Obtain it from the Hostinger Mail API GET /api/v1/me response. Do not put your account's mailbox identifier in this public repository.
6. Configure COUNTER_DATA_DIR to a writable persistent directory outside hbuilds/public_html.
7. Redeploy and perform one real signup using an address you control. Check the notification in connect@feyros.com.

Do not paste secret keys into chat, source files, screenshots or GitHub. Only the public Turnstile site key is exposed to visitors. Until all four mail/bot settings exist, the page displays "The waitlist opens soon" and rejects submissions. No signup is falsely accepted while delivery/protection is unconfigured.

## Spam protection

- Required server-side Turnstile verification, including hostname and action.
- Signed form nonce bound to an HttpOnly/SameSite browser cookie, with minimum form age and expiry.
- Matching request Origin; small JSON-only payloads; email validation and explicit consent.
- Hidden bot-trap input, five attempts per browser session per fifteen minutes, and thirty submissions per server per minute.
- Serialized duplicate checks and atomic writes. Existing addresses receive the same public response without another notification.
- Default daily cap of 100 new notification attempts, persisted across restarts. Adjust WAITLIST_DAILY_LIMIT deliberately.
- Fixed notification destination, plain-text body and fixed subject prevent arbitrary email forwarding or header injection.
- No reliance on spoofable forwarded-IP headers or raw visitor IP storage.

A bot check does not establish email ownership. These are consented interest signups, not a double-opt-in mailing audience. Add ownership confirmation and unsubscribe links before sending a wider subscriber campaign. The feature does not monitor unrelated incoming mailbox spam.

## Private storage and email delivery

The app stores waitlist.json beside counters.json in the private data directory. Records include email, signup/consent timestamp and notification state. They are never served through public routes. Back up this directory; use a database before running multiple workers.

A notification attempt is recorded before sending. "sent" means the mail API accepted the request, not independent proof of inbox delivery. "uncertain" or a leftover "sending" state needs operator review. Ambiguous provider timeouts are not automatically resent, to avoid duplicate mail. The signup remains saved. Inspect private storage and mailbox before any manual resend.

To honor removal requests sent to connect@feyros.com, stop the app, remove the matching record from the private waitlist.json file without changing other records, then restart. Do not post the file publicly.

## Verification

CI builds the deployed files, tests the real HTTP endpoints with mocked mail/security providers and verifies desktop/mobile behavior in Chromium. Tests cover duplicate/concurrent signups, nonce/cookie/origin validation, missing config, spam trap, rate limits, payload bounds, storage failure, uncertain delivery, restart behavior and countdown math. Provider mocks do not prove live key configuration or real inbox delivery. CI preview screenshots are attached to the workflow run.

Official references:
- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
- https://developers.cloudflare.com/turnstile/reference/content-security-policy/
- Hostinger Email API schema, discovered through the connected Hostinger Mail API documentation: https://api.mail.hostinger.com
