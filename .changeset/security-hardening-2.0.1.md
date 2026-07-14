---
"cimisy": patch
---

Security hardening pass: fixes a TOCTOU race in the local storage adapter, closes a media-upload gap, adds login rate limiting, and enforces a minimum session-secret length.

**Breaking for existing deployments — action required before upgrading:** `githubSource({ sessionSecret })` now throws `WEAK_SESSION_SECRET` at construction time if `sessionSecret` is shorter than 32 characters (or missing). This is the key that signs the admin session cookie — a short one is brute-forceable. Generate a proper one with `openssl rand -base64 32` and update your deployment's `CIMISY_SESSION_SECRET` (or equivalent) before upgrading, or the app will fail to start.

Other fixes:

- **TOCTOU race in `LocalStorageAdapter.list()`** (CodeQL CWE-367): replaced the `stat()`-then-`readFile()` pattern, where a file could change or disappear between the two calls, with a direct `readFile()` per entry that skips `ENOENT`/`EISDIR` — the same check-free idiom already used by `read()`.
- **Unvalidated `targetKey` on media upload**: `POST /api/cimisy/media` now 404s if `targetKey` doesn't match a declared collection or singleton, closing a gap where a writer could mint draft branches/PRs for content keys that don't exist in config.
- **`/auth/login` now rate-limited**, the same IP-keyed limiter already applied to `/auth/callback`.
- Dev/example dependency bumps clearing ~60 Dependabot alerts (none were in the package's published runtime dependencies): `next` to `^15.5.16`, `vitest` to `^3.2.6`, plus `postcss`/`esbuild`/`vite` pinned via `pnpm.overrides` where transitive resolution still lagged. The `next` peer range is unchanged (`>=14.0.0`). The two example apps' route handlers and internal library types were updated for Next 15's Promise-based route `params`, and a couple of internal nav links were switched to `next/link` to satisfy `eslint-config-next`'s `no-html-link-for-pages` rule.
