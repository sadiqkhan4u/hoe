# Hostinger staging — hoe.dating

## Status

The repository is initialized on `main`. The Hostinger connection has **not been completed or verified**.

- GitHub repository: https://github.com/sadiqkhan4u/hoe
- Branch: `main`
- Requested target: a new staging website at `hoe.dating`
- Existing website: `heavenonearth.app` is not part of this staging change

The repository currently contains documentation only; there is no runnable application or page to deploy yet. Choose the hosting type and application framework before adding deployment commands.

## Connection options

### Custom HTML/PHP web hosting

1. In Hostinger hPanel, create or select the new staging website for `hoe.dating`.
2. Open its Dashboard → Advanced → Git.
3. Connect GitHub and grant Hostinger access to this repository only where that choice is offered.
4. Select `sadiqkhan4u/hoe`, branch `main`.
5. Verify that the deployment target belongs to `hoe.dating` (normally its `public_html` directory).
6. Add and review the initial website files before the first deployment, then verify a successful deployment record and the staging page.

### Managed Node.js web app

After a supported application has been added to this repository, use Websites → Create Website → Web App → Import Git Repository. Select this repository and `main`, verify the framework/build/start settings, and deploy to a staging preview before connecting `hoe.dating`.

Hostinger's managed Node.js app hosting requires a compatible hosting plan. AI Builder websites do not support the standard Git integration. Confirm the hosting type in hPanel rather than assuming one.

## Domain and verification

Connect `hoe.dating` to the new staging website using the domain settings offered by the selected Hostinger product. Check current DNS and domain ownership before any DNS changes. Confirm HTTPS, the repository and branch shown in Hostinger, and a successful deployment before treating the connection as complete.

Keep credentials and environment values in hosting settings, never in repository files. Do not change the existing site's repository connection or hosting configuration while setting up staging.

## Official references

- [Hostinger Git deployment](https://www.hostinger.com/support/1583302-how-to-deploy-a-git-repository-in-hostinger/)
- [Hostinger Node.js web apps](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/)
