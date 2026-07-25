# Threat Model

cimisy installs directly into a Next.js app and holds write credentials to the app owner's GitHub repository. This document enumerates what's worth protecting, where trust boundaries actually are, and walks through the specific attack scenarios the codebase is designed against — with pointers to the mitigating code and the tests that verify it. It's meant to be read scenario-by-scenario against the code, not just taken on faith.

## Assets

| Asset | Where it lives | Notes |
|---|---|---|
| GitHub App private key | `CIMISY_GITHUB_APP_PRIVATE_KEY` env var, server-only | Signs App-level JWTs; compromise = full write access to every repo the App is installed on |
| GitHub App client secret | `CIMISY_GITHUB_APP_CLIENT_SECRET` env var, server-only | Used only for OAuth code exchange |
| Session secret | `CIMISY_SESSION_SECRET` env var, server-only | Signs the session cookie (HS256) |
| One-variable config blob | `CIMISY_CONFIG` env var, server-only | base64url (not encrypted) JSON carrying all three secrets above — same blast radius, fewer places to leak from. See scenario 16 |
| App Manifest code | Process memory during `cimisy setup github`, never persisted | Single-use, 1-hour expiry; redeemable without authentication for the App's private key and client secret. See scenario 17 |
| Installation access tokens | Minted per-request, never persisted, never sent to the browser | Short-lived (~1h), scoped to the App's installation |
| Session cookies | Browser, httpOnly | Carries identity only (GitHub user id/login/name/email) — never a GitHub token, never a role (role is always re-derived server-side) |
| Repository content | The consuming app's own git repo | The actual CMS content — this is what the whole system exists to protect the integrity of |
| Draft branches / open PRs | GitHub | Unpublished content; visible to anyone with read access to the repo (same as any other branch) |

## Trust boundaries

- **Browser: untrusted.** Nothing client-side (the admin UI, `cimisy/render`'s output) is trusted to enforce anything. Every `"use client"` component in `src/react/` either has no access to secrets at all, or receives only a manifest that's already been stripped of schemas, functions, and the storage adapter (`src/next/manifest.ts`).
- **The Next.js server: the only trusted boundary.** Every route handler independently re-verifies identity, role, and input shape — it never trusts that "the UI already checked this." This is the specific mitigation for IDOR-class bugs (see below).
- **GitHub's API: a trusted third party, but not blindly.** Collaborator-permission lookups are cached only briefly (60s) so a revoked collaborator loses access promptly rather than only after their session cookie eventually expires (`src/rbac/resolve-role.ts`).
- **The git repository itself: content provenance is not trusted.** Anyone with git write access can hand-edit a file completely outside cimisy's UI. Every place that reads content re-validates it as if it might be hostile — the read path never assumes "this came from cimisy's own editor, so it's safe."

## Attack scenarios and mitigations

### 1. MDX/JSX code injection (the core RCE risk of a git-based CMS storing MDX)
**Mitigation:** `src/mdx/ast-allowlist.ts`'s `assertSafeMdxTree` recursively rejects `mdxjsEsm` (import/export), `mdxFlowExpression`/`mdxTextExpression` (`{...}` escape hatches), any JSX tag not declared by a registered block, JSX spread attributes, and expression-valued JSX attributes — everywhere in the tree, not just top-level. This runs inside `src/mdx/parse.ts`, which both the admin editor's read path and the public Reader's read path go through via the same `content/codec.ts` → `parseEntry` call — a hand-edited malicious file is rejected regardless of how it got there.
**Verified by:** `src/mdx/__tests__/ast-allowlist.test.ts` (24-case permanent malicious-MDX fixture corpus: import/export smuggling, expression injection at every position, unknown-tag injection). Also verified live in M4: a post created through the admin UI produced clean MDX, and a hand-edited malicious file placed directly on disk was rejected on read.

### 2. IDOR / broken object-level authorization
**Mitigation:** A single centralized choke point, `src/rbac/require-permission.ts`'s `requirePermission`, called before every read/write/delete/history request touches storage. Deny-by-default: no matching rule means no access, full stop.
**Verified by:** `src/next/__tests__/route-handler.test.ts`'s explicit IDOR regression test — a request body forging `role: "admin"`, `isAdmin: true`, `directPublish: true` has zero effect, because the handler never reads authorization from the request body at all, only from the server-resolved session.

### 3. CSRF
**Mitigation:** Two independent layers. (a) Session cookies are `sameSite: "lax"`, which browsers refuse to attach to cross-site POST/PUT/DELETE requests. (b) `src/next/csrf.ts`'s `requireSameOrigin` independently verifies the `Origin` (falling back to `Referer`) header matches the app's own origin, applied to every state-changing admin route and to `auth/logout`. Fails closed: a request with neither header present is rejected.
As of v2.5.1 the expected origin is a small set rather than a single value: the origin the request actually arrived on, plus a deployer-configured `CIMISY_PUBLIC_URL` (or Vercel's `VERCEL_PROJECT_PRODUCTION_URL`) when one is set — see `src/next/public-origin.ts`. This exists because behind a `Host`-rewriting proxy the server's view of its own origin differs from the browser's, which made every state-changing admin request fail. Both entries are trusted inputs: one is where the request landed, the other is deployment configuration. Request headers deliberately feed none of it — `X-Forwarded-Host` in particular is attacker-controllable on a directly-reachable origin, and this value gates the comparison.
**Verified by:** `route-handler.test.ts`'s CSRF describe block (mismatched origin, no origin, Referer fallback, GET routes correctly exempt), `next/__tests__/public-origin.test.ts` (fails closed with no headers, rejects a foreign origin, and does not widen the set for a spoofed `X-Forwarded-Host`), and a live test against a running dev server confirming all three cases.

### 4. Path traversal
**Mitigation:** Defense-in-depth at every layer that builds a path from user input, each re-validating independently rather than trusting an earlier check: `assertSafeSlug`/`assertSafeRepoPath` (`src/shared/slug.ts`), `resolveSafe` in the local adapter (`src/storage/local.ts`), path checks in the GitHub adapter (`src/adapters/github/adapter.ts`), and `assertSafeRefComponent`/`assertSafeSlug` in git-ref/branch-name construction (`src/shared/branch-name.ts`). Route-level slug validation happens before authorization or any handler logic sees it (`src/next/route-handler.ts`'s `parseRoute`), not after.
**Verified by:** `src/shared/__tests__/path-traversal-fuzz.test.ts` — a permanent 40-payload corpus (`../`, absolute paths, null bytes, URL-encoded and double-encoded variants, overlong UTF-8, backslash/UNC paths, oversized input) applied against every path-validating function in the codebase.

### 5. Secret/token leakage into the client bundle
**Mitigation:** `import "server-only"` at the top of every module that touches the GitHub App private key, client secret, session secret, or installation tokens — a build-time error if a client component ever imports one transitively, not a runtime hope. The admin UI receives only a manifest with schemas, access-rule functions, and the storage adapter already stripped (`src/next/manifest.ts`).

### 6. Vendor lock-in / unnecessary persistence of the user's own GitHub token
**Mitigation:** By design, not just policy: the user's OAuth access token is used exactly once, to fetch their identity (`src/github/oauth.ts`), and is never stored anywhere — not in the session cookie, not server-side. All repo reads/writes go through the App's own installation token, minted fresh per request and never sent to the browser.

### 7. Denial of service via deeply nested content
**Mitigation:** `assertSafeMdxTree`'s recursive tree walk is depth-limited (`MAX_TREE_DEPTH = 200`). This was a real bug found during M4 testing, not a hypothetical: a hand-edited file with ~20,000 nested blockquotes crashed with an uncaught `RangeError: Maximum call stack size exceeded` before the fix, which is a genuinely worse failure mode than a clean rejection (undefined behavior vs. a controlled 400).
**Verified by:** tests up to 200,000-deep payloads, all cleanly rejected with `ValidationError`.

### 8. Denial of service via one broken file taking an entire collection offline
**Mitigation:** `listEntries` (`src/content/collection-store.ts`) isolates parse/validation failures per file — a bad entry surfaces as `{error}` on that one entry's summary, not a thrown exception that fails the whole request. Also a real bug found during M4 live testing (a single malicious file made `GET /collections/posts` fail entirely), fixed, and covered by `collection-store.test.ts`.

### 9. Optimistic-concurrency races / lost updates
**Mitigation:** Per-file `baseVersion` comparison in every adapter's `commitChange` before anything is written. The GitHub adapter adds a second, independent guard: `force: false` fast-forward-only ref updates, catching a race in the narrow window between the per-file check and the actual commit landing.
**Verified by:** `local.test.ts` and `adapter.test.ts`'s conflict-detection tests (including a `createBranch`/`openChangeRequest` idempotency bug found and fixed during M3 testing).

### 10. Privilege escalation via session/role forgery
**Mitigation:** Session cookies are signed (`jose`/HS256) with the algorithm explicitly pinned (not trusted from the token's own header) to rule out alg-confusion attacks. Role is never carried in the session or read from the client — it's re-derived server-side on every request from the session's GitHub identity via `resolveRole`.
**Verified by:** `session.test.ts`, including an explicit `alg: "none"` forgery attempt and a tampered-payload/mismatched-signature test.

### 11. Open redirect via the preview-enabling endpoint
**Mitigation:** `safeRedirectPath` (`src/next/draft-mode.ts`) only accepts same-origin relative paths; absolute and protocol-relative (`//evil.com`) targets are neutralized to `/`.
**Verified by:** `draft-mode.test.ts` and `route-handler.test.ts`.

### 12. Brute-forcing/abuse of the OAuth login/callback or admin writes
**Mitigation:** `src/security/rate-limit.ts`'s `RateLimiter` interface, applied to both OAuth entry points — `/auth/login` and `/auth/callback` (IP-keyed, sharing the same bucket — there's no identity yet at that point) — and admin API writes (identity-keyed — the realistic abuse case is a compromised/buggy authenticated client, not anonymous traffic). The shipped default is explicitly **not** safe to rely on across multiple serverless instances (see its own doc comment) — it's a sane local-dev/single-instance default, not a scalability promise. Production deployments on serverless/multi-instance infra should supply their own `RateLimiter` backed by shared storage.
**Verified by:** `rate-limit.test.ts` and a live test confirming a 429 with a `Retry-After` header once the limit is exceeded.

### 13. YAML frontmatter type-coercion / tag-execution tricks
**Mitigation:** `content/codec.ts` uses `yaml`'s `parseDocument` (not the lenient `parse` shortcut) and treats **any** warning — not just hard errors — as a rejection. Found during M1 testing that `parse()` silently tolerates unresolvable tags like `!!js/function` (inert under the Core schema, but too permissive for a security-first parser); fixed to fail closed.
**Verified by:** `codec.test.ts`.

### 14. In-admin scan/import — an authenticated admin request that rewrites source files
The dev-only scan surface (`POST /scan`, `GET /scan/report`, `POST /scan/import` in `next/route-handler.ts`) is a genuinely new class of endpoint: it doesn't write *content*, it rewrites the project's *source code* (pages, components, `cimisy.config.ts`) and creates git branches. Left open on a deployed server, it would be an attacker's shortcut from "compromised admin session" to "arbitrary code committed into the app".
**Mitigation (layered):**
- **Existence gate:** all three routes return 404 unless the storage adapter is the local adapter (`source.kind === "local"`) **and** `NODE_ENV !== "production"` — the same conditions under which the source checkout is, by definition, the developer's own machine. The gate is checked server-side per request (`scanSurfaceAvailable`), independently of the manifest flag that merely hides the UI.
- **CSRF:** both `POST` routes require same-origin (`requireSameOrigin`), and share the identity-keyed write rate limit.
- **No client-supplied code paths:** imports are addressed by kind+index into the server's own cached report (`.cimisy/scan-report.json`); the request body never carries file paths, offsets, or candidate objects. A stale index fails the whole request before any write.
- **Git safety rails (shared with the CLI, `scan/git.ts`):** refuse outside a git repository, refuse on a dirty working tree unless explicitly overridden, and write only on a fresh `cimisy/import-<timestamp>` branch — every change is reviewable and revertible before it can land.
**Verified by:** `next/__tests__/scan-routes.test.ts` (gate under github source, gate under `NODE_ENV=production`, cross-origin rejection, not-a-repo refusal, stale-selection refusal, end-to-end branch import).

### 15. Supply chain
**Mitigation:** Dependencies are pinned via a committed lockfile. JWT construction and installation-token exchange are delegated to `@octokit/auth-app` rather than hand-rolled — reusing a well-audited, widely-used library for exactly the kind of code where a subtle bug is catastrophic. CI dependency scanning and CodeQL are described in the repo's `.github/workflows/`.

### 16. `CIMISY_CONFIG` — one variable carrying every secret
Before v2.5 a GitHub-backed deployment needed seven environment variables, one of them a multi-line PEM. `CIMISY_CONFIG` packs all of them into a single base64url line (`src/env/blob.ts`).
**This does not widen the blast radius**, and it's worth being precise about why: the blob is a *transport encoding*, not encryption, and anyone who can read it could equally have read the seven variables it replaces. What changes is the number of places a secret can be mishandled — one dashboard field instead of seven, no multi-line PEM to mangle, nothing to transcribe. The historical failure mode here was a private key pasted into the wrong field, or into a public repo, precisely because it was awkward to handle.
**Mitigations:**
- **Never echoed on failure.** Every rejection path in `decodeCimisyConfigBlob` reports the *shape* of the problem (not base64url / not JSON / unsupported version / missing field names) and never the blob, a slice of it, or any decoded value — so a malformed blob in a CI log or a pasted bug report leaks nothing. Enforced by an explicit test.
- **One deliberate print, clearly labeled.** The wizard prints the blob exactly once, at the handoff step, preceded by a blank line and a warning naming what it contains and where not to paste it. That print is the whole point of the variable existing; everything else in the wizard is silent about secret values.
- **Version-stamped.** `v: 1` is required, so a future field change is recognized (`UNSUPPORTED_CONFIG_BLOB_VERSION`) rather than silently misread by an older cimisy.
- **Unknown keys dropped.** The decoder rebuilds the options object field by field, so a tampered blob carrying extra keys can't smuggle them into `githubSource(...)`.
- **All-or-nothing precedence.** `CIMISY_CONFIG` wins outright over the individual variables and the two forms never merge (`src/env/read-env.ts`), with a warning when both are present. A half-blob/half-vars configuration would make "which credential is actually live?" unanswerable from a dashboard, which is exactly the state a stale leftover variable creates.
**Verified by:** `src/env/__tests__/blob.test.ts` (round trip, truncated/tampered/wrong-version/unversioned blobs, the never-echo-contents assertion) and `resolve-source.test.ts` (precedence, no merging, warning content contains no secret).

### 17. The setup wizard's localhost callback server and manifest exchange
`cimisy setup github` (`src/cli/manifest-flow.ts`) briefly runs an HTTP server on the developer's machine that receives, from a browser, a one-time code redeemable — *without any authentication* — for a GitHub App's private key and client secret. That is a genuinely new trust boundary: a local HTTP listener holding the landing spot for a credential-bearing redirect.
**Mitigations (layered):**
- **Loopback bind only.** `listen(0, "127.0.0.1")` — never `0.0.0.0`, which would expose the callback to the local network for the life of the wizard.
- **Unguessable state, compared in constant time.** 32 random bytes generated per run, echoed back by GitHub, verified with `timingSafeEqual` (`statesMatch`). A mismatch rejects the run outright and never redeems the code, so another process on the machine can't drive a code into the wizard's exchange.
- **Exactly one callback.** The first callback settles the run; any replay gets a 410 and is not processed. Any path other than `/` and `/callback` is a 404.
- **Immediate shutdown.** The listener is torn down the moment the code lands or the run fails, not when the caller remembers to close it. A 10-minute hard timeout aborts an abandoned run with a clean message.
- **The code is never persisted or logged.** It exists only as a local variable, is dropped as soon as it's redeemed, and appears in no error message — including the failure path, where GitHub's own message is surfaced but the code is not. The manifest is HTML-attribute-escaped into the auto-submitting form so nothing in it can break out of the attribute.
- **Received credentials go only to `.env.local`.** The PEM and client secret exist in process memory and in that file, which is created `0600` on POSIX; the wizard checks `.gitignore` covers it and offers to fix it if not, failing closed (an unrecognized ignore pattern is reported as *not* covered, since a false "ignored" is how a private key reaches a public repo).
- **No secret reaches argv.** The Vercel fast path pipes `CIMISY_CONFIG` over the child process's stdin, never as a command-line argument, which would put it in shell history and in every process listing on the machine.
- **The App it creates is minimal.** Private (installable only on the owning account), no webhook declared at all, and exactly three permissions — Contents: write, Pull requests: write, Members: read. The manifest builder is snapshot-tested so widening that set has to be a deliberate, reviewed change.
**Verified by:** `src/cli/__tests__/manifest-flow.test.ts` (loopback binding, state match/mismatch, missing code, single-use replay, 404 on other paths, clean timeout, no code in the error message) and `manifest.test.ts` (permission set and callback URLs, exact).

### 18. Unconfigured production deployments
`resolveSourceFromEnv({ onIncomplete: "placeholder" })` lets a deployment missing its GitHub variables build and serve rather than throwing at config import. The risk to check is that a "degraded" mode never becomes an *unauthenticated* mode.
**Mitigation:** the placeholder source (`src/storage/unconfigured.ts`) has no credentials and no storage — every read/list/write throws a typed `SOURCE_UNCONFIGURED` error, so there is nothing to serve and nothing to write. Every API route returns 503 before any handler logic runs. The `/admin` page it renders is deliberately inert: no inputs, no form, no client script, no state — a README rendered in place, not the in-admin credential wizard the project decided against, which on a necessarily-unauthenticated page would be a public "paste your private key" form. It shows only non-secrets: the missing variable *names*, the callback URL derived from the request origin, and the commands to run.

**Scope limit (not a mitigation, a documented boundary):** the placeholder keeps the app building, but a public page that *statically prerenders* content through `createReader` still fails its build-time read. That is deliberate — prerendering an empty page instead would ship a silently-wrong site, which is a worse failure than a loud one. Documented in the README's "Environment variables" section.
**Verified by:** `src/next/__tests__/unconfigured-routes.test.ts` (503 across every method and route, missing names present, no stack trace in the body), `unconfigured-page.test.tsx` (asserts the page contains no `<input>`, `<form>`, `<script>`, or `<button>`), and `src/storage/__tests__/unconfigured.test.ts`.

## Accepted risks / explicitly out of scope for v1

- **The local storage adapter has no authentication at all.** By design — it's for local development. It refuses to run when `NODE_ENV=production` unless explicitly overridden with `allowInProduction: true`, which is intentionally undocumented as a recommended production path.
- **The default in-memory rate limiter is not distributed.** Documented as an extension point, not silently glossed over — see scenario 12.
- **No raw-MDX editing escape hatch exists yet.** If one is added later, it must be forced through the identical `assertSafeMdxTree` validator before persisting, and gated behind an explicit `admin`-only, opt-in flag (see `SECURITY.md`).
- **Webhook signature verification is not yet implemented.** Webhooks aren't on the critical read/write path in v1 (installation-removed/PR-merged events aren't consumed by anything yet), so this is deferred rather than a live gap.
- **Media/asset storage is in-repo only for v1.** No separate upload endpoint exists yet, so there's no additional surface to secure there.
- **`/preview/enable` is a state-changing `GET`.** It only flips draft-mode on for the requesting browser (no data exposure — draft content still goes through the normal RBAC-gated read path), so a cross-site top-level navigation that triggers it is low impact: at most an unwanted UI toggle, not a data leak or write. Not redesigned as a `POST` because that would break the plain `<a href>`/direct-link preview flow it exists for.
