---
"cimisy": patch
---

Fixes for deploying to Vercel (and anything behind a proxy), plus two `.env.local` correctness bugs.

**A production deploy with no cimisy variables set no longer crashes the build.** Pushing to a host before running `npx cimisy setup github` leaves nothing configured, which resolves to the local adapter — and that adapter rightly refuses to run under `NODE_ENV=production`, but it did so by throwing at config import, failing the whole build with an error about an adapter you never chose. Under `onIncomplete: "placeholder"` that now becomes the unconfigured source instead: the guard rail is unchanged (the local adapter still never runs in production), but the deploy builds and `/admin` explains what to set. Note a public page that statically prerenders content through `createReader` still can't build without a source — it now fails with an error naming the missing variables and the command to fix them.

**Sign-in now works on Vercel preview deployments and behind `Host`-rewriting proxies.** The OAuth `redirect_uri` and the CSRF origin check were both derived from the URL the server saw. Every Vercel preview gets a unique hostname and GitHub Apps don't support wildcard callback URLs, so preview sign-in always failed with a redirect-URI mismatch. cimisy now resolves its public origin from `CIMISY_PUBLIC_URL`, else Vercel's `VERCEL_PROJECT_PRODUCTION_URL` (the stable production domain, picked up with no configuration), else the request's own origin as before. Only deployer-set configuration feeds this — never a request header, since the value gates the CSRF comparison.

**`cimisy setup github` no longer leaves a duplicate key that silently overrides what it just wrote.** `.env` files are last-one-wins, so a second assignment of a key below the one being updated meant the wizard reported success while the app kept loading the old credentials. Duplicates of keys being set are now removed, and reported in the CLI output rather than dropped silently.

**An unterminated quote in `.env.local` no longer hides every variable below it.** The parser treated the value as running to end-of-file, so `cimisy doctor` reported set variables as missing and the wizard rotated a session secret it should have reused (logging everyone out). Replacing such a key would also have deleted the lines beneath it.

The README's Vercel guide is rewritten around the two-command path, with a troubleshooting table, preview-deployment behavior, and a note that the GitHub App must be owned by the same account as the content repo.
