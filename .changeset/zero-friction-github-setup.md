---
"cimisy": minor
---

Zero-friction GitHub setup: `cimisy setup github`, one-variable config, and `cimisy doctor`.

Pointing a cimisy deployment at GitHub used to take about thirty fiddly minutes: hand-register a GitHub App, tick three permission boxes, type a callback URL correctly, download a PEM and paste it into an environment field that mangles newlines, generate a client secret, invent a session secret, set seven variables, install the App, and hand-write a `resolveSource()` switch in `cimisy.config.ts` that every project reinvented slightly differently. Most of those steps failed silently.

**`npx cimisy setup github`** replaces the whole thing with one browser confirmation. It uses GitHub's official App Manifest flow: you're taken to a *pre-filled* App creation page — permissions, callback URLs, and settings already chosen — and after you confirm and install it, the wizard writes `.env.local` (additively; your other keys are untouched, and a fresh file is created `0600`), waits until the App is really installed on the repo, verifies repository access, and prints **one** environment variable to paste into your deployment platform. It offers to set that variable on Vercel for you if the project is already linked, and finishes with a verification checklist.

**`CIMISY_CONFIG`** is that one variable: a single base64url line carrying the repo, branch, App id, private key, client id, client secret, and session secret. Nothing to transcribe, no multi-line PEM to mangle. It's a transport encoding, not encryption — exactly as sensitive as the seven variables it replaces — so treat it like the secret it is. The individual `CIMISY_*` variables still work; `CIMISY_CONFIG` takes precedence when both are set, and the two forms never merge.

**New `cimisy/env` subpath.** Consumer configs collapse to one call:

```ts
import { resolveSourceFromEnv } from "cimisy/env";

export default config({
  source: resolveSourceFromEnv({ contentDir: "./content", onIncomplete: "placeholder" }),
  // ...collections unchanged
});
```

Local disk when nothing is set, the GitHub adapter when it is. `onIncomplete: "placeholder"` (what `cimisy setup` now scaffolds) means a deployment that's missing some variables still *builds*: the API answers 503 naming exactly what's absent, and `/admin` renders a static page explaining what to set and what that deployment's callback URL is — instead of failing the build with a stack trace. The default stays `"throw"`, so fail-fast is still available.

**`npx cimisy doctor`** verifies a configuration before your users do: which source resolves and from which form, every required variable present, the session secret long enough, the private key parsed for real (the classic failure is a PEM whose newlines a dashboard ate — it still *looks* like a PEM), App credentials accepted by GitHub, App installed on the repo, Contents and Pull-requests permissions actually *granted* rather than merely requested, branch exists, collaborator lookup works, and both routes mounted. Each check prints a fix hint. `--json` for CI; exit 0/1/2.

No breaking changes — explicit `githubSource({ ... })` callers are unaffected, and the individual variable names are the ones cimisy's own error messages already referenced.
