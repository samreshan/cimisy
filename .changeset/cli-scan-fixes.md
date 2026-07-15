---
"cimisy": patch
---

Fix two `cimisy scan` bugs:

- **Crash on any plain Node invocation of the CLI.** `config()` (in `config/define-config.ts`) eagerly constructed a default in-memory rate limiter at config-definition time, importing `security/rate-limit.ts`, which starts with `import "server-only"`. Under Next.js's server compiler that's a no-op (the `react-server` export condition), but the CLI is a plain Node process where `server-only` always throws — so merely loading a project's `cimisy.config.ts` crashed `cimisy scan`/`cimisy import` before they could do anything. `rateLimiter` now stays unresolved on `ResolvedCimisyConfig` until `next/route-handler.ts`'s new `resolveRateLimiter` constructs (and memoizes, so it's not rebuilt per request) the in-memory default lazily, the one place it's actually consumed — `cimisy/config` no longer has any path to `security/rate-limit.ts` at all.
- **`cimisy scan` finding zero pages in a plain-JavaScript App Router project.** `scan/discover-pages.ts` matched only the exact file name `page.tsx`; Next.js's App Router also recognizes `page.ts`, `page.jsx`, and `page.js`, so a JS (non-TS) project silently got `pages: []` and every downstream candidate list came up empty. All four extensions are now recognized.
