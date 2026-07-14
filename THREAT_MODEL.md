# Threat Model

cimisy installs directly into a Next.js app and holds write credentials to the app owner's GitHub repository. This document enumerates what's worth protecting, where trust boundaries actually are, and walks through the specific attack scenarios the codebase is designed against — with pointers to the mitigating code and the tests that verify it. It's meant to be read scenario-by-scenario against the code, not just taken on faith.

## Assets

| Asset | Where it lives | Notes |
|---|---|---|
| GitHub App private key | `CIMISY_GITHUB_APP_PRIVATE_KEY` env var, server-only | Signs App-level JWTs; compromise = full write access to every repo the App is installed on |
| GitHub App client secret | `CIMISY_GITHUB_APP_CLIENT_SECRET` env var, server-only | Used only for OAuth code exchange |
| Session secret | `CIMISY_SESSION_SECRET` env var, server-only | Signs the session cookie (HS256) |
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
**Verified by:** `route-handler.test.ts`'s CSRF describe block (mismatched origin, no origin, Referer fallback, GET routes correctly exempt) and a live test against a running dev server confirming all three cases.

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

### 14. Supply chain
**Mitigation:** Dependencies are pinned via a committed lockfile. JWT construction and installation-token exchange are delegated to `@octokit/auth-app` rather than hand-rolled — reusing a well-audited, widely-used library for exactly the kind of code where a subtle bug is catastrophic. CI dependency scanning and CodeQL are described in the repo's `.github/workflows/`.

## Accepted risks / explicitly out of scope for v1

- **The local storage adapter has no authentication at all.** By design — it's for local development. It refuses to run when `NODE_ENV=production` unless explicitly overridden with `allowInProduction: true`, which is intentionally undocumented as a recommended production path.
- **The default in-memory rate limiter is not distributed.** Documented as an extension point, not silently glossed over — see scenario 12.
- **No raw-MDX editing escape hatch exists yet.** If one is added later, it must be forced through the identical `assertSafeMdxTree` validator before persisting, and gated behind an explicit `admin`-only, opt-in flag (see `SECURITY.md`).
- **Webhook signature verification is not yet implemented.** Webhooks aren't on the critical read/write path in v1 (installation-removed/PR-merged events aren't consumed by anything yet), so this is deferred rather than a live gap.
- **Media/asset storage is in-repo only for v1.** No separate upload endpoint exists yet, so there's no additional surface to secure there.
- **`/preview/enable` is a state-changing `GET`.** It only flips draft-mode on for the requesting browser (no data exposure — draft content still goes through the normal RBAC-gated read path), so a cross-site top-level navigation that triggers it is low impact: at most an unwanted UI toggle, not a data leak or write. Not redesigned as a `POST` because that would break the plain `<a href>`/direct-link preview flow it exists for.
