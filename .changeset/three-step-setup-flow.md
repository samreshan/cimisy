---
"cimisy": patch
---

Three-step onboarding: `cimisy scan --full` → `cimisy import` → `cimisy setup`.

- New `cimisy setup` command auto-scaffolds what the quickstart used to ask you to write by hand: `cimisy.config.*` (when `cimisy import` hasn't already created it), the admin UI page at `app/(cimisy)/admin/[[...segments]]/page.tsx`, and the API route at `app/api/cimisy/[...route]/route.ts`. It detects `app/` vs `src/app/`, TypeScript vs plain-JavaScript projects, and tsconfig path aliases (emitting `@/cimisy.config`-style imports when an alias covers the config, relative imports otherwise). It never overwrites existing files — including an admin page you hand-mounted outside the `(cimisy)` route group — so re-running it is always safe.
- `cimisy scan --full` is un-deprecated: it's now the blessed shorthand for `--mode=static-metadata` (no warning), since it's step 1 of the flow.
- `scan` and `import` now point to the next step in the flow, and stop suggesting `cimisy setup` once both routes exist.
