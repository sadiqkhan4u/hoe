# Hostinger staging: hoe.dating

Import the existing **sadiqkhan4u/hoe** GitHub repository as a **Node.js web app** for the new staging website.

## Import settings

| Setting | Value |
| --- | --- |
| Repository | https://github.com/sadiqkhan4u/hoe |
| Branch | main |
| Project root | repository root (leave blank or use .) |
| Framework | Other — backend Node.js app |
| Node.js version | 22.x |
| Package manager | npm |
| Build command | npm run build |
| Output directory | dist |
| Entry file | server.mjs |
| Start command, if shown | npm start |
| Domain | hoe.dating |

The build places server.mjs, app.mjs, package.json and public/index.html into dist. server.mjs also exists at repository root, so it works whether the panel resolves the entry relative to the root or built output. The root start command uses dist/server.mjs; the built package's start command uses server.mjs. The server listens on Hostinger's PORT and 0.0.0.0. Do not manually override PORT.

Refresh the repository list and reselect hoe after this update. The missing-package.json message should clear once Hostinger reads the new main branch.

## Counter data

Before launch, set:

- NODE_ENV=production
- COUNTER_DATA_DIR=an absolute writable path outside hbuilds and public_html

Choose the actual path using the account's filesystem; do not paste an invented account username. If omitted, the server uses the home directory's .hoe/data folder. Verify that directory is writable and survives deployment. Back it up periodically. This single-process file store is suitable for the coming-soon page; use a shared database for a scaled app.

## Verify deployment

1. Confirm the Hostinger build finishes successfully.
2. Open /health and expect {"status":"ok"}.
3. Open the homepage and verify the mobile and desktop layout.
4. Refresh within the same browser session: visits should stay unchanged.
5. Verify the supplied logo is compact and blends into the page on mobile and desktop. The page and counters API should show only browser visits.
6. Redeploy and check that totals persist.
7. Attach hoe.dating to this new site, complete the DNS records supplied by Hostinger, and verify HTTPS.

The GitHub build tests verify the app, not the Hostinger account configuration. The initial deployment is confirmed by the supplied Hostinger success screen. Public DNS/HTTPS and counter persistence still need independent verification.

Official guide: https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/
