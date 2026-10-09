# HOE — Heaven On Earth

Starter repository for the Heaven On Earth dating application. The current release is a responsive coming-soon page for the new staging website **hoe.dating**, with a Filmymantra link and server-side counters.

## Run locally

Use Node.js 22 or newer. No third-party packages are needed.

```sh
npm run build
npm test
npm start
```

Open http://localhost:3000. For editing without rebuilding, run `npm run dev`.

## Deploy to Hostinger

See [HOSTING.md](HOSTING.md). The root package.json enables Node.js repository import. The build creates a complete runnable app in `dist/`.

The app includes a simple text/CSS brand mark using the champagne and rose angel/heart/devil direction. The approved transparent image can replace it when that asset is uploaded.

## Counter meaning and storage

- **Browser visits:** one successful landing-page GET per browser session, using a session cookie. Refreshes within that session do not increment.
- **Filmymantra link clicks:** one request to the outgoing link per browser session. The server redirects to https://filmymantra.com/. This measures clicks, not confirmed destination arrivals.
- Bot traffic, private browsing and clearing cookies affect the totals. These are activity counts, not verified unique people.
- Totals are serialized and atomically saved to `counters.json`. Set `COUNTER_DATA_DIR` to an absolute writable directory that persists outside Hostinger deployment folders. The default is `~/.hoe/data`; persistence and permission on the actual hosting account still need verification.
- Storage is intended for one Node.js process. Use a shared database before scaling to multiple workers/instances. No visitor IP addresses or personal details are stored.
- Never commit counter data, keys or environment files. Back up the data directory before migration.

## Verification

GitHub Actions builds and tests the deployment output, including session deduplication, redirects, concurrent increments, restart persistence, private-route handling and the real server entry.

## Deployment status

Repository prepared for Node.js import. Hostinger deployment, persistent storage permissions, domain mapping and HTTPS for hoe.dating have not yet been verified.
