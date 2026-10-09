# HOE — Heaven On Earth

Starter repository for the Heaven On Earth dating application. The current release is a responsive coming-soon page for the new staging website **hoe.dating**, with a server-side browser-visit counter.

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

The page uses the supplied HOElogo.png at a compact responsive size. Screen blending lets any black matte merge into the plum background without changing the original artwork.

## Counter meaning and storage

- **Browser visits:** one successful landing-page GET per browser session, using a session cookie. Refreshes within that session do not increment.
- Bot traffic, private browsing and clearing cookies affect the totals. These are activity counts, not verified unique people.
- Visit totals are serialized and atomically saved to `counters.json`. Set `COUNTER_DATA_DIR` to an absolute writable directory that persists outside Hostinger deployment folders. The default is `~/.hoe/data`; persistence and permission on the actual hosting account still need verification.
- Storage is intended for one Node.js process. Use a shared database before scaling to multiple workers/instances. No visitor IP addresses or personal details are stored.
- Never commit counter data, keys or environment files. Back up the data directory before migration.

## Verification

GitHub Actions builds and tests the deployment output, including session deduplication, logo serving, legacy counter migration, concurrent increments, restart persistence, private-route handling and the real server entry.

## Deployment status

Hostinger's supplied success screen confirms the initial deployment from this repository. Public domain reachability, persistent storage permissions and HTTPS for hoe.dating still need independent verification.
