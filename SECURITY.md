# Security Policy

cimisy holds write credentials to your GitHub repository (via a GitHub App) and mediates who can read and write content in it. Security issues here are taken seriously and prioritized over new features.

## Supported versions

Only the latest published 2.x version receives security fixes. There is no long-term-support branch yet.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting instead: go to the repository's **Security** tab → **Report a vulnerability**. This opens a private advisory visible only to maintainers until a fix is ready.

If private reporting isn't available for some reason, email the address listed in the repository's `package.json` `author`/`maintainers` field.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (a minimal `cimisy.config.ts` + request sequence is ideal).
- Which component is affected (config engine, GitHub adapter, RBAC, MDX parsing/rendering, auth/session, admin UI).

### What to expect

- Acknowledgement within 5 business days.
- An initial assessment (severity, affected versions) within 10 business days.
- Coordinated disclosure: we'll work with you on a fix and a disclosure timeline before any public advisory is published. We credit reporters in the advisory unless you prefer to stay anonymous.

## Scope

In scope:

- The `cimisy` npm package itself (`packages/cimisy`): the config engine, storage adapters, RBAC, MDX parsing/serialization/rendering, auth/session handling, and the admin UI it ships.
- The example apps in `examples/*`, to the extent they demonstrate the package's intended secure configuration.

Out of scope:

- Vulnerabilities in GitHub's own platform (report those to GitHub directly).
- Vulnerabilities that require an attacker to already have valid GitHub App credentials, a valid admin session, or `write` access to the target repository through means other than cimisy itself — those are captured as accepted risks in [THREAT_MODEL.md](./THREAT_MODEL.md), not vulnerabilities in cimisy.
- Issues in a consuming application's own code that don't stem from a cimisy API behaving other than documented (e.g. a site that renders unsanitized user input completely outside of cimisy's Reader/renderBlocks path).

## Security-relevant design documentation

See [THREAT_MODEL.md](./THREAT_MODEL.md) for the assets, trust boundaries, and specific attack scenarios cimisy is designed against, mapped to the code and tests that mitigate each one.

## Disclosure of known escape hatches

Some capabilities are deliberately dangerous and opt-in, not defaults:

- A raw-MDX-editing mode (if ever added) would bypass the block editor's structured input but would still be forced through the same AST allowlist validator before being persisted (see `THREAT_MODEL.md`).
- The local filesystem storage adapter has no authentication at all by design (it's for local development) and refuses to run when `NODE_ENV=production` unless explicitly overridden with `allowInProduction: true` — this override is intentionally not documented as a recommended production configuration.
