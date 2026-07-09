# cimisy

A git-based, security-first CMS that installs directly into an existing Next.js app — no separate server, no hosted database. Content is plain MDX + YAML frontmatter, versioned in your own repo.

**Status: v1 released (M7 of 7).**

This is the monorepo: the published package, two runnable examples, and this repo's own dev tooling. If you're looking to *use* cimisy in your own app, start with **[the package README](./packages/cimisy/README.md)** — it has the real quickstart, config reference, RBAC guide, GitHub App setup walkthrough, and migration notes. This file covers the repo itself.

## Try it

**Local adapter (no setup required):**

```sh
pnpm install
pnpm --filter cimisy build
pnpm --filter next-local dev
```

Then open `http://localhost:3000/admin` for the editor, or `http://localhost:3000/blog` for the public site rendered via the Reader API.

**GitHub adapter (requires registering your own GitHub App — see `examples/next-github/README.md` or [the package README's setup guide](./packages/cimisy/README.md#setting-up-a-github-app)):**

```sh
pnpm install
pnpm --filter cimisy build
cp examples/next-github/.env.local.example examples/next-github/.env.local  # fill in your App's credentials
pnpm --filter next-github dev
```

## Packages

- `packages/cimisy` — the published `cimisy` npm package ([its README](./packages/cimisy/README.md) is the canonical usage doc)
- `examples/next-local` — a minimal Next.js app demonstrating the local-adapter flow
- `examples/next-github` — a Next.js app demonstrating the GitHub-adapter + auth + RBAC + draft/PR flow

## Repo layout & dev workflow

Plain pnpm workspace, no Turborepo/Nx. From the repo root:

```sh
pnpm install
pnpm run lint        # all packages + examples
pnpm run typecheck   # all packages + examples
pnpm run test        # vitest, packages/cimisy only (examples have no tests of their own)
pnpm run build       # packages/cimisy only — see note below
```

`build` is deliberately scoped to `packages/*`, not the examples: `examples/next-local` uses the local storage adapter, which refuses to run once `NODE_ENV=production` (by design — it has no auth, direct disk writes). A `next build` of that example is expected to fail with `LOCAL_ADAPTER_IN_PRODUCTION`, which is the guard rail working correctly, not a broken build.

### Releasing

This repo uses [Changesets](https://github.com/changesets/changesets). Contributors run `pnpm changeset` to describe a change; merging to `main` triggers `.github/workflows/release.yml`, which either opens a "Version Packages" PR (if unreleased changesets exist) or publishes `packages/cimisy` to npm with provenance once that PR is merged. Publishing prefers npm's OIDC trusted publishing (no long-lived `NPM_TOKEN`) — see the workflow file for the one-time setup this needs on npmjs.com, and its comments for the `NPM_TOKEN`-based fallback if trusted publishing isn't configured yet.

Only `packages/cimisy` is published — both example apps are `private: true` and excluded via `.changeset/config.json`'s `ignore` list.

## Security

cimisy holds write credentials to your repository; see [SECURITY.md](./SECURITY.md) for the vulnerability reporting process and [THREAT_MODEL.md](./THREAT_MODEL.md) for the assets, trust boundaries, and specific attack scenarios this project is designed against, each mapped to the code and tests that mitigate it.

## Development history

Built milestone-by-milestone, each independently demoed and verified (lint/typecheck/test/build plus live smoke testing) before moving on:

<details>
<summary><strong>M1 — config engine + local adapter (dev-only)</strong></summary>

- A typed `cimisy.config.ts` config/schema engine (`collection`, `singleton`, `fields`)
- A local filesystem storage adapter (dev-only — refuses to run under `NODE_ENV=production`)
- Optimistic-concurrency-safe reads/writes/deletes against MDX files
- Strict, allowlist-based slug/path validation (no path traversal by construction)
- Fail-closed YAML frontmatter parsing (any parse warning is treated as a hard error)
</details>

<details>
<summary><strong>M2 — GitHub-backed storage + GitHub App auth</strong></summary>

- A GitHub storage adapter using the Git Data API (blob/tree/commit/ref) for atomic multi-file commits, with the same per-file optimistic-concurrency semantics as the local adapter
- GitHub App authentication: App-level JWT + installation-token exchange delegated to `@octokit/auth-app` (not hand-rolled), installation ID resolved and cached per repo
- User sign-in via GitHub App user-OAuth (identity-only — no user access token is ever persisted; all repo reads/writes go through the App installation token instead)
- Signed, httpOnly, sameSite session cookies (`jose`/HS256, alg pinned, tamper- and expiry-tested); CSRF-protected OAuth state via a double-submit cookie
- The whole admin API requires a valid session when the GitHub source is configured
- `createBranch` / `openChangeRequest` / `mergeChangeRequest` / `getHistory` implemented and tested
</details>

<details>
<summary><strong>M3 — layered RBAC + branch/PR publish workflow</strong></summary>

- Two-layer authorization: GitHub's own collaborator permission level (admin/maintain/write/triage/read) maps to a cimisy role, which then gates specific path-glob rules (`content/blog/**`, `**`, etc.) — a working, secure-by-default role set ships out of the box, no team has to hand-roll one
- A single centralized `requirePermission` choke point enforced on every read/write/delete before the storage adapter is ever touched — deny-by-default, and covered by an explicit IDOR regression test (a forged client-supplied `role`/`isAdmin` field in a request body has zero effect; only the server-resolved session role matters)
- Direct-publish roles commit straight to the default branch; everyone else drafts on a deterministic per-user/per-entry branch (`cimisy/<username>/<collection>/<slug>`) with an auto-opened PR — repeated saves land on the same branch/PR instead of duplicating it
- Merging/approving a draft is deliberately *not* reimplemented — that's GitHub's own PR review and branch protection; cimisy only opens the PR and surfaces its link in the admin UI
- Collaborator-permission lookups are cached briefly (60s) so a revoked collaborator loses access promptly rather than only after their session cookie eventually expires
</details>

<details>
<summary><strong>M4 — block editor + safe MDX serialization</strong></summary>

- A block registry (`paragraph`, `heading`, `code`, `image`, `callout`) where each block declares how it round-trips to mdast/MDX — native markdown for paragraph/heading/code (inert, no JSX needed), real JSX elements for image/callout (the ones that map to actual React components on the consuming site)
- Content is built as mdast AST nodes from zod-validated props — never string-concatenated into MDX source, which is what rules out attribute-breakout injection at the write path
- A strict AST allowlist validator gates the read path: rejects `import`/`export` (mdxjsEsm), `{expression}` syntax (mdxFlowExpression/mdxTextExpression), any JSX tag not declared by a registered block, JSX spread attributes, and expression-valued JSX attributes — recursively, everywhere in the tree, not just at the top level
- A permanent malicious-MDX fixture corpus (24 tests) covering import/export smuggling, expression injection (flow/text/attribute/spread), unknown-tag injection, and DoS shapes (deep nesting, wide flat documents) — every payload is asserted rejected, not just spot-checked
- Found and fixed a real DoS bug while building this: the validator's tree walk was unbounded recursion, so a deeply-nested hand-edited file crashed with an uncaught stack overflow instead of a clean rejection — now depth-limited with a proper `ValidationError`
- Found and fixed a related availability bug: a single hand-edited (malicious *or just broken*) file used to take the *entire* collection listing down with it; per-file parse errors are now isolated so one bad file shows as one broken row, not a dead admin panel
- A genuine multi-block editor UI (add/remove/reorder, type-appropriate controls per block) driven entirely by manifest data the server sends — no per-project UI code needed when a config registers different block types
- Verified live end-to-end: created a post exercising all 5 block types through the admin API, confirmed clean human-readable MDX output, confirmed round-trip fidelity, and confirmed a hand-edited malicious file placed directly on disk (never touching the UI) is rejected on read while leaving the rest of the collection listable
</details>

<details>
<summary><strong>M5 — preview via Draft Mode + Reader API</strong></summary>

- A public-facing Reader (`createReader`, `cimisy/next`) — no auth, no RBAC (it's what renders a site's own pages for any visitor), draft-mode aware, and going through the exact same `parseEntry` → `assertSafeMdxTree` validation path as the admin API, so a hand-edited malicious file is rejected here too, not just in the admin UI
- A direct block-tree → React renderer (`renderBlocks`, `cimisy/render`) instead of the MDX-text recompilation the plan sketched — since content is already a validated block tree by the time the Reader returns it, re-serializing back to MDX text just to recompile it via `@mdx-js/mdx`/`next-mdx-remote` would be redundant and pull in a heavier dependency for no safety benefit; sensible unstyled defaults ship for all 5 built-in block kinds, fully overridable per block type
- Real Next.js Draft Mode integration: a `cimisy_preview_ref` cookie (default branch, or a specific draft branch) rides alongside Next's own `__prerender_bypass` cookie, so the Reader can tell "preview world" from "published world" per request without a rebuild
- An authenticated, RBAC-gated preview-enabling route with explicit open-redirect prevention (a `redirectTo` pointing anywhere off-site is neutralized, not passed through)
- An optional `previewPath` template on collection config (e.g. `"/blog/:slug"`) surfaced through the manifest, so the admin UI shows a real "Preview" link with zero per-project UI code
- Verified live end-to-end: created a post, confirmed it renders correctly via the Reader + `renderBlocks` on a real public route, then ran the full enable → banner-appears → disable → banner-gone preview cycle against a running dev server and confirmed both cookies are set/cleared correctly at each step
</details>

<details>
<summary><strong>M6 — security hardening pass + audit trail + docs</strong></summary>

- CSRF protection on every state-changing admin route (`src/next/csrf.ts`): `Origin` header verified against the app's own origin, falling back to `Referer`, failing closed when neither is present — a second, independent layer on top of `sameSite: "lax"` session cookies
- A pluggable `RateLimiter` interface (`src/security/rate-limit.ts`) applied to admin writes (identity-keyed) and the OAuth callback (IP-keyed), returning a real `429` + `Retry-After`; ships an honest in-memory default that's explicitly documented as unsafe across multiple serverless instances rather than overpromising production-readiness
- A full zod-boundary audit across every API route: every `request.json()` now goes through a schema (`writeEntryBodySchema`, `deleteEntryBodySchema`) via a shared `parseJsonBody` helper instead of an unchecked type cast
- Found and fixed a real ordering bug during that audit: slugs were being authorized by RBAC *before* being validated as safe paths. Slug validation now happens the moment a slug is parsed (from the URL or the request body), before any permission check runs
- A consolidated path-traversal fuzz sweep (`path-traversal-fuzz.test.ts`, ~40 payloads × 4 path-building functions, 169 cases) — this caught a real inconsistency in `draftBranchName`, which validated the attacker-influenced `slug` component with a looser, mixed-case-permissive pattern than the lowercase-only `assertSafeSlug` used everywhere else a slug becomes a path; fixed to use the stricter validator
- An activity-log panel in the admin UI surfacing real git history per entry (`GET .../history`), backed by an adapter-optional `getHistory` capability — reports `{supported: false}` cleanly on adapters (like local) that don't have one, rather than erroring
- `SECURITY.md` (private vulnerability reporting via GitHub's Security tab, scope, disclosure timeline) and `THREAT_MODEL.md` (assets, trust boundaries, and 14 specific attack scenarios mapped to the exact file and test that mitigates each one)
- CI: lint/typecheck/test/build on every push and PR, CodeQL (`javascript-typescript`, `security-extended`, weekly + every PR), and Dependabot for both npm and GitHub Actions dependencies
</details>

<details>
<summary><strong>M7 — public v1 release</strong></summary>

- Changesets wired up (`@changesets/cli`, `.changeset/config.json` scoped to `packages/cimisy` only — both example apps are `private: true` and ignored); a real release dry run performed locally: `changeset version` correctly bumped `cimisy` to `1.0.0` and generated `CHANGELOG.md` from the changeset, and `npm publish --dry-run` against the built package confirmed a clean, correctly-scoped tarball (145+ files, `dist/` only, plus `README.md`/`LICENSE`)
- `.github/workflows/release.yml`: on push to `main`, runs lint/typecheck/test, then either opens a "Version Packages" PR or publishes to npm with provenance via `changesets/action`, preferring npm's OIDC trusted publishing over a long-lived `NPM_TOKEN`
- `packages/cimisy/package.json` filled out with real publish metadata (`repository`, `homepage`, `bugs`, `keywords`, `publishConfig: { access: "public", provenance: true }`)
- A real `packages/cimisy/README.md` — the actual npm package page: quickstart, GitHub App setup guide, full config reference (`config`/`collection`/`singleton`/`fields`/`blocks`), RBAC guide, Reader/render usage, Draft Mode, security summary, and migration notes — plus a bundled `LICENSE`
- Verified end-to-end exactly like a real first-time install, not just unit tests: built the package, `npm pack`'d the real tarball, `npm install`'d it into a from-scratch Next.js app outside this workspace, copy-pasted the README's own quickstart snippets verbatim (config, admin page, API route), booted the dev server, and created a post through the real admin API — confirmed a clean `.mdx` file with correct frontmatter landed on disk, exactly as documented
</details>

## License

Apache-2.0
