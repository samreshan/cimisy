# cimisy

## 2.4.0

### Minor Changes

- 6762233: Admin UI/UX overhaul plus a dev-only in-admin scan/import surface — v2.4.0.

  **Scan & import without leaving the admin (local dev only).**

  - A new **Scan** screen (`/admin/scan`) runs the whole-site scanner in-process and imports selected candidates — mode picker for all four scan depths, results grouped exactly like the CLI report (collection / static / metadata candidates plus every "not import-eligible" bucket with reasons), checkboxes, and one "Import selected" action with per-candidate success/failure output.
  - **Exists only where it can't hurt anyone**: the API routes (`POST /scan`, `GET /scan/report`, `POST /scan/import`) and the nav item appear only with the local adapter outside `NODE_ENV=production` — everywhere else they 404, indistinguishable from not existing. Writes require same-origin and share the write rate limit; selections address the server's own cached report by index, never client-supplied candidates.
  - Import safety mirrors the CLI exactly (shared code in `scan/git.ts`, extracted from the CLI rather than copied): refuses outside a git repo, refuses on a dirty working tree (with an explicit "import anyway" override), and writes only on a fresh `cimisy/import-<timestamp>` branch. After an import the screen marks the cached report stale and requires a re-scan before importing again (byte offsets no longer match the rewritten sources). The scan stack is dynamic-imported so the TypeScript compiler never loads on ordinary admin requests. THREAT_MODEL.md documents the new surface.
  - `scan` and `media` are now reserved top-level content keys (config() rejects them; the scanner's key-derivation mirror refuses them too).

  **New field types.**

  - **`fields.boolean()`** — a real YAML boolean. The scanner now proposes it for boolean values (and `fields.number()` for numeric values), which removes the old "booleans stored as `"true"`/`"false"` strings invert your truthy checks" import caveat entirely.
  - **`fields.number()`** — with optional `isRequired`/`min`/`max` validation; optional fields default to `null`.
  - **`fields.select()`** — one-of-a-fixed-set strings, rendered as a dropdown.
  - **`fields.text({ multiline: true })`** — renders a textarea; storage identical to text.
  - **`fields.array()` generalized** — the wrapped item field's kind now reaches the admin (manifest `item`), so arrays of numbers, selects, and multiline text get proper per-item inputs instead of assuming text.

  **Editor experience.**

  - **Autosaved local drafts**: unsaved edits are debounce-snapshotted to localStorage per entry; on the next load a "Restore unsaved draft?" gate offers them back (crash/battery/force-quit insurance — complements the existing beforeunload guard). Snapshots clear on save/delete/discard.
  - **Cmd/Ctrl+S saves** in the entry and singleton forms.
  - **Drag-and-drop block reordering** in the block editor's outline list (move buttons stay as the keyboard-accessible path, now with proper aria-labels).
  - **Headings are rich text**: bold/italic/inline-code/links inside headings now round-trip — the heading block schema moved from `{level, text}` to `{level, content: InlineNode[]}` (same shape as paragraphs; a back-compat shim upgrades in-flight 2.3 payloads, and on-disk files need no migration).
  - **Callout tone is switchable live in the editor** — the tone select in the callout node is no longer disabled.
  - **Honest live preview labeling**: the preview pane now says "last saved version" with a "save to update" badge while dirty, instead of an ambiguous "draft" chip.

  **Media library.** A standalone **Media** screen (`/admin/media`): browse every configured image directory, upload via button or drag-and-drop (multi-file, with progress state), copy a file's path for reuse, and delete (optimistic-concurrency-checked `DELETE /media`, confined to configured image directories). Library writes with no entry context ride the reserved `media/library` draft target, so editor-role uploads still land on a reviewable branch. `POST /media` accordingly accepts uploads without `targetKey`/`slug` (both-or-neither enforced).

  **Visual polish & responsiveness.**

  - Loading skeletons (layout-preserving, reduced-motion aware) replace every bare "Loading…" paragraph across the admin.
  - Phone-width layout: the nav links wrap into their own scrollable row, grids/paddings/title hero scale down, team rows stack.
  - The blanket `.cimisy-root * { transition: … }` rule is gone — transitions are scoped to interactive elements, plus a global `prefers-reduced-motion` kill switch.
  - Accessibility pass: `role="alert"`/`role="status"` on the remaining banners, meaningful alt text on media thumbnails, labeled icon-only (↑/↓/Remove) buttons, announced loading states.
  - Richer empty states with CTAs (first-entry create, media upload hints), and dashboard cards now show field counts.
  - **Entry lists scale**: search, sort (title/slug), and 25-per-page pagination appear once a collection outgrows a handful of entries.

  **Onboarding.**

  - Zero-content dashboard becomes a getting-started state (with a "Scan this project" CTA in local dev); when a cached scan report has importable findings, the dashboard nudges "the last scan found N importable pieces — review & import".
  - `githubSource()` now fails at config load with the exact missing credential names and their env-var spellings (`CIMISY_GITHUB_APP_ID`, …) instead of an opaque mid-request 500; a failing `/auth/me` shows the server's message instead of falling through to the sign-in gate.
  - The draft branch chip explains itself on hover, and the Drafts screen states what a draft is.

## 2.3.0

### Minor Changes

- 4e8d421: Whole-site static scan (modes, metadata import, CI gate) plus four data-loss-grade admin fixes.

  **`cimisy scan` covers the whole site, in four selectable depths.**

  - **Every App Router entrypoint is scanned** — not just `page.*` files: `layout.*`, `template.*`, `not-found.*`, `loading.*`, `error.*`, and `global-error.*` (plus pages inside `@slot` parallel-route directories; `(.)`-style intercepting-route dirs are skipped). A layout's content spans every page route in its subtree, and regions found _only_ via layout/template files are always proposed as shared top-level singletons — even on a single route, nesting them under that page would orphan them the moment a second page appears. Route derivation now strips `@slot` segments like route groups.
  - **Four scan modes replace the boolean `--full`**: `collections` (default), `collections-metadata`, `static`, `static-metadata`. Select with `--mode=<mode>`, or set a default in `cimisy.config.ts` via the new `scan: { mode, exclude }` key (read statically — literals only, the CLI never executes your config; `exclude` skips appDir-relative path prefixes at discovery). Precedence: `--mode` > config > default. `--full` still works as a deprecated alias for `--mode=static-metadata` and prints a notice.
  - **Page metadata is now importable, not report-only.** `cimisy import` offers `export const metadata = { title, description, openGraph: { url } }` candidates: it inserts a `seo: section({ schema: { seo: fields.seo() } })` under the page's config entry (sharing one `page()` with any static sections imported for the same route), writes the values as YAML through the same validated write path the admin uses, and replaces the statement with a `generateMetadata()` reading it back via `createMetadata()`. Offsets are re-derived at apply time, so it coexists with other candidates edited into the same file in one run.
  - **The metadata analyzer is hardened for deletion-safety**: metadata with properties `fields.seo()` can't store (`keywords`, `robots`, `openGraph.images`, …), divergent `openGraph.title`/`description`, non-object-literal initializers, and existing `generateMetadata()` exports are all reported as not import-eligible instead of silently tolerated; `satisfies Metadata` wrappers are unwrapped.
  - **CI mode**: `cimisy scan --ci` exits 0 only when nothing was found (unanalyzable detections count — they're still hardcoded content), 1 on findings, 2 on scan failure, with a one-line summary on stderr. `--json` prints the full report to stdout with project-root-relative paths (the on-disk `.cimisy/scan-report.json` cache keeps absolute paths so `cimisy import` keeps working). Reports now carry `mode` and `reportVersion`.
  - Fixed a latent type error in the static-content codemod: generated `cimisyReader.pages.<key>.<section>.get()` didn't typecheck in strict TS projects (`PageReader` values are `CollectionReader | SingletonReader`); TS rewrites now emit a `SingletonReader` assertion.

  **Admin fixes (all four are data-loss-grade):**

  - **Saves are validated before they're written.** Previously the write path ran no field validation at all — a save violating `isRequired`/`maxLength` succeeded and produced an entry that could never be loaded again. Field zod schemas now gate `writeEntry`/`writeSingleton`, failures return the existing `{ error, issues }` 400 with field-prefixed issue paths, and the admin shows the message inline on the offending input (plus required markers, `maxLength`, and a pre-submit required check). Optional text/image/array fields left untouched now round-trip via schema defaults (`""` / `null` / `[]`) instead of writing unreadable files — and a YAML _sequence_ document no longer sneaks past the "must be a mapping" check as all-defaults.
  - **Unsaved changes are guarded.** Navigating away from an edited entry/singleton (link click, tab close, reload) now asks for confirmation instead of silently discarding edits.
  - **Entries can be deleted from the UI.** The DELETE API existed but nothing called it. The editor now has a two-step confirm delete that sends `baseVersion` (real 409 conflict handling); direct-publish roles return to the list, draft roles stay put with a "deletion opened as a draft PR" banner and link, since the entry remains published until the PR merges.
  - **Failed loads show errors with a Retry button** instead of hanging forever: the entry list (which also crashed with a TypeError on a non-OK response body), the history panel, and the admin shell's own `/auth/me` check (one flaky request used to brick the whole admin on "Loading…").

## 2.2.7

### Patch Changes

- 0902b35: Fix two more `cimisy import` correctness bugs found running it against a real app:

  - **Codegen had zero awareness of `"use client"`.** `createReader` (`cimisy/next`) imports the `server-only` package, and every codemod path made the rewritten component's default export `async` — both are outright incompatible with a Client Component (`server-only` cannot load in a client bundle at all, and React doesn't support async Client Components regardless). `cimisy scan`/`cimisy import` now detect a file's `"use client"` directive and report its candidates as unanalyzable (`this file is a Client Component...`) instead of rewriting it into a page-breaking 500. Splitting such a file into a Server Component wrapper + inner Client Component is a bigger follow-up, not done here — this stops the crash safely in the meantime.
  - **Boolean fields were coerced to text with the same generic note as numbers.** cimisy has no boolean field type, so a scanned `isPlaceholder: true` was proposed as `fields.text()` and stored as the literal string `"true"`/`"false"` — but unlike a number, this isn't display-safe: any non-empty string (including `"false"`) is truthy in JS, so a pre-existing `{field && <Badge/>}` check would render for both values after migrating, silently inverting whatever `false` meant. Boolean fields now get a distinct, explicit warning about this in the scan report, instead of the same "will be stored as text" note used for numbers.

## 2.2.6

### Patch Changes

- ffc4d14: Fix `cimisy import`'s config-source detection ignoring the actual value of `process.env.NODE_ENV` when the config uses the README's own recommended local/production switch:

  ```ts
  source:
    process.env.NODE_ENV === "development"
      ? localSource({ rootDir: "./content" })
      : githubSource({ /* ... */ }),
  ```

  `detectSource` statically walks the config's AST for `localSource(...)`/`githubSource(...)` calls without any awareness of conditionals — for the ternary above it found both calls and kept whichever came last in source order (`githubSource`, since it's always the `:` branch), regardless of the real `NODE_ENV`. `cimisy import` then refused to run at all ("uses githubSource"), even in local dev. It now recognizes a ternary keyed on `process.env.NODE_ENV` and evaluates it against the CLI's actual `NODE_ENV`, so the branch that would really execute is the one inspected. A conditional keyed on anything else is left as `unknown` rather than guessed at.

  Also: the "uses githubSource" / "could not determine storage adapter" errors now name the config file that was actually read (e.g. `cimisy.config.js`) instead of always saying `cimisy.config.ts`.

## 2.2.5

### Patch Changes

- 503810e: Fix five `cimisy import` codegen bugs found running it against a real, previously-hand-configured app:

  - **Unquoted kebab-case keys were a hard syntax error.** Section/page/singleton/collection keys derived from a scanned id/className (e.g. `block-2`) were emitted as bare, unquoted object keys (`block-2: section({...})`), which doesn't parse. Generated keys are now quoted whenever they aren't a valid bare identifier — matching what `fields.text()` etc. already did for field names — and every place that looks a key back up (to merge into it, or check for a collision) now recognizes both a bare identifier and a quoted string literal.
  - **That same corruption silently duplicated top-level pages.** Once one candidate's insertion produced an unquoted, unparseable key, every later candidate targeting that same page could no longer find it in the AST and re-created it from scratch — `careers: page({...})` appearing three times, with only the last surviving at runtime (duplicate object keys silently drop the earlier ones). Fixing the quoting bug fixes this as a direct consequence: pages/sections now always merge correctly.
  - **TypeScript-only syntax was injected into plain `.jsx` files.** The static-content codemod (unlike the collection codemod, which already had this check) unconditionally emitted `as {...}` type assertions, a guaranteed parse failure under a JS-only toolchain. It now detects `.ts(x)` vs `.js(x)` the same way the collection codemod does and omits the cast for plain JavaScript.
  - **Config-file detection only recognized `cimisy.config.ts` by exact name.** A project with an existing hand-authored `cimisy.config.js` (or `.mjs`) was never found — `cimisy import` silently scaffolded a second, competing, empty `.ts` config instead of merging into the real one. It now checks for `.ts`/`.tsx`/`.js`/`.mjs`/`.cjs` in that priority order before falling back to scaffolding a new `.ts` file.
  - **Applying multiple candidates that share one source file corrupted or crashed.** Each candidate's byte offsets are captured once, at scan time; applying an earlier candidate edits the file and shifts every offset after it, so a later candidate's stale offsets pointed at the wrong text — sometimes throwing a clear "could not re-locate" error, sometimes (for collection candidates) silently splicing garbage into the file. Offsets are now always re-derived from the file text actually being edited, matched by a position-independent identity (a region's id/className hint, or an array's variable name). A related bug in the same area — two candidates sharing one enclosing function each re-declaring `const cimisyReader = ...`, an actual `SyntaxError`, or (once de-duplicated) inserting a later fetch _above_ the earlier one's declaration, a `ReferenceError: Cannot access 'cimisyReader' before initialization` at runtime — is fixed too.

## 2.2.4

### Patch Changes

- 680b78c: Fix two `cimisy scan` gaps found while auditing a real app's coverage:

  - **Default-imported arrays were invisible.** `resolveImportedArrayDeclaration` only followed plain named imports (`import { leaders } from "..."`) one hop to their declaration — a default import (`import chaptersRaw from "../data/about-timeline.json"`, or a plain `export default [...]` data module) was silently skipped, even though `.json` data imports are always default imports under webpack/Next's JSON interop. `cimisy scan` (and `--full`) now resolves both shapes, and `cimisy import`'s codemod cleans up the resulting default-import binding (or deletes the `.json` file outright, since its whole content is the array) the same way it already did for named imports.
  - **Page-level SEO metadata was never scanned.** Every Next.js App Router page can export `export const metadata = { title, description, openGraph: { url } }` for its SEO — `cimisy scan --full` now detects this (mirroring `findStaticContent`'s "detect but don't guess" posture: a non-literal field is reported as unanalyzable, not dropped) and lists it in the report as `pageMetadataCandidates`/`pageMetadataUnanalyzable`. This is reporting-only for now — `cimisy import` doesn't yet offer these for automatic migration into a `fields.seo()` singleton.

## 2.2.3

### Patch Changes

- 3b9ef19: Fix `cimisy scan` only resolving JSX components one hop deep from the route file. `runScan` called `findJsxSections` exactly once, against the literal `page.tsx`/`.jsx` — so a component it rendered (e.g. `LeadershipPage`) was scanned for arrays, but any component _that_ component rendered (e.g. `LeadershipGrid`) never was. This is invisible for a page that renders its content directly, but breaks the common `page.tsx` (thin, Next.js-required route file) → `XxxPage.tsx` (the real page) → individual section components convention — anything past the first hop was structurally unreachable regardless of whether its array was declared locally or imported from a data module (see the previous patch's cross-file resolution).

  `runScan` now BFSes: it calls `findJsxSections` on the route file, then again on every newly-resolved component file, repeating until nothing new turns up, guarding against import cycles with a visited set. A candidate's `section` is now the deepest component that actually renders it, not necessarily the page's direct child.

## 2.2.2

### Patch Changes

- d813766: Fix two more `cimisy scan`/`cimisy import` bugs, both surfaced by running against a plain-JavaScript project:

  - **Unbounded `typescript` peer range.** `peerDependencies.typescript` had no upper bound (`>=5.0.0`), so a fresh install could silently pull in TypeScript 7 (the from-scratch Go rewrite), whose package exports map the bare `"."` specifier at a stub with no compiler API (`ts.createSourceFile`, `ts.ScriptTarget`, etc. all undefined) — every file in `scan/`, `codegen/`, and `config-detection.ts` that does `import ts from "typescript"` would crash. Capped to `>=5.0.0 <6.0.0`, the range actually exercised by this package's classic-compiler-API usage.
  - **The scanner only found arrays declared in the same file as their `.map()` call.** Data factored into its own module (`data/leadership.js`, imported as `import { leaders } from "../../data/leadership"` and mapped elsewhere) is arguably the more common shape than an inline array, but was silently dropped — not even reported as unanalyzable. `findRepeatingContent` now follows one hop through a plain named import (mirroring `findJsxSections`'s existing component resolution) back to a matching top-level `export const` in the target module; `cimisy import`'s codemod correctly rewrites both files in that case (deletes the data module's declaration, removes the now-stale import, and inserts the fetch at the `.map()` call site). Default/namespace imports and re-exports are intentionally left unresolved rather than guessed at.
  - Along the way, fixed two more TS-only assumptions that would've otherwise still broken a plain-JS project even with the above: the scanner's import resolver (`resolveOnDisk`) only tried `.tsx`/`.ts` file extensions (missing `.jsx`/`.js`), and the array→fetch codemod always inserted a TypeScript `as {...}` type-cast even when rewriting a plain `.js`/`.jsx` file, which doesn't parse as valid JavaScript.

## 2.2.1

### Patch Changes

- bcca9ae: Fix the admin UI's `fields.array()` editor (used for tags/list-style fields) rendering blank when opening an existing entry. `FieldInput` had no case for `kind === "array"`, so it fell through to the plain-text branch, which coerced the array value to `""` for display — the data was never lost (an untouched Save round-tripped the original array unchanged), but an editor had no way to see or edit existing list items. Adds a dedicated `ArrayField` component: a reorderable list of text inputs with add/remove/move controls.
- bcca9ae: Fix two `cimisy scan` bugs:

  - **Crash on any plain Node invocation of the CLI.** `config()` (in `config/define-config.ts`) eagerly constructed a default in-memory rate limiter at config-definition time, importing `security/rate-limit.ts`, which starts with `import "server-only"`. Under Next.js's server compiler that's a no-op (the `react-server` export condition), but the CLI is a plain Node process where `server-only` always throws — so merely loading a project's `cimisy.config.ts` crashed `cimisy scan`/`cimisy import` before they could do anything. `rateLimiter` now stays unresolved on `ResolvedCimisyConfig` until `next/route-handler.ts`'s new `resolveRateLimiter` constructs (and memoizes, so it's not rebuilt per request) the in-memory default lazily, the one place it's actually consumed — `cimisy/config` no longer has any path to `security/rate-limit.ts` at all.
  - **`cimisy scan` finding zero pages in a plain-JavaScript App Router project.** `scan/discover-pages.ts` matched only the exact file name `page.tsx`; Next.js's App Router also recognizes `page.ts`, `page.jsx`, and `page.js`, so a JS (non-TS) project silently got `pages: []` and every downstream candidate list came up empty. All four extensions are now recognized.

## 2.2.0

### Minor Changes

- 8211e9d: `cimisy scan --full` now also detects static, non-repeating content — headings, rich-text paragraphs, images, and standalone links — grouped into sections at semantic HTML5 boundary tags (`<section>`, `<header>`, `<footer>`, etc.), with a fallback region per component when no boundary tag is present. `cimisy import` presents these alongside collection candidates in one combined picker; selecting one writes a real `.yaml`/`.mdx` entry via `writeSingleton`, splices a `singleton({...})` or `page({...}){ sections }` into `cimisy.config.ts`, and rewrites the source JSX to read from `reader.singletons.<key>`/`reader.pages.<pageKey>.<sectionKey>` — the same git-branch-review trust model as collection imports (clean working tree or `--allow-dirty`, a dedicated `cimisy/import-<timestamp>` branch, no runtime RBAC involved).

  Detection is conservative by design, mirroring the existing array scanner: content mixed with a non-literal expression (`Welcome to {siteName}`, `{t("key")}`), conditionally rendered content (`{cond && <X/>}`, ternaries), and ESM-imported images (`import hero from "./hero.png"`) are reported as detected-but-not-eligible rather than guessed at. Only a narrow tag/prop allowlist is ever read as content (headings, `p`/`blockquote` rich text, `figcaption`, `span`, `img`/`Image`, `a`/`Link`) — `className`, `data-*`, `aria-*`, event handlers, and every other prop are never touched.

  A component rendered from a single route becomes a page-scoped `section()`; the same component rendered from multiple routes (e.g. a shared `Footer`) becomes a top-level `singleton()` instead.

  The admin content tree now separates a page's static content from its collections into two labeled groups instead of one flat list.

  No breaking changes — `cimisy scan`/`cimisy import` without `--full` behave exactly as before.

## 2.1.2

### Minor Changes

- Admin UI retheme + dark mode. The admin editor now uses Cimisy Blue and the same-hue "ink" neutral ramp (`brand/design-system`) in place of the original bone/charcoal/purple palette — the retheme `brand/BRAND.md` had deliberately deferred — and every surface has a matching dark theme, auto-detected from the OS and toggleable from a new button in the top nav (persisted to `localStorage`, applied before first paint so there's no flash).

  Alongside the retheme, the entry editor picked up a few layout changes to read as a calmer, less chrome-heavy writing surface:

  - A `cimisy / collection / entry` breadcrumb trail replaces the old "&larr; back" link + heading.
  - The first plain-text field in a collection's schema now renders as a large, borderless hero title instead of a boxed input — the field editors reach for as "the title" in practice, not `slugField` (which names whatever the URL slug is derived from, often a separate auto-generated field).
  - The block editor shows its "type to insert a block" hint inline, in whichever block is currently empty (via the new `@tiptap/extension-placeholder` dependency, admin-UI-only like the rest of the Tiptap family), instead of as static text below the editor. The slash-command menu also gained a small icon per block kind.
  - The preview pane's header is now a "Draft mode preview" label with a status pill, and a sticky action bar at the bottom of the form surfaces the draft's branch and PR link next to Save — replacing the inline banners that used to carry that after a save.

  Also fixes a bug found while verifying the above: `EntryForm`/`SingletonForm` could get stuck on "Loading…" forever if the initial fetch failed validation (e.g. a required field left empty) instead of surfacing the error.

  No public API changed — `AdminApp`'s props, the manifest shape, and every route/handler are untouched. If you've overridden `.cimisy-*` class styles from the outside, re-check them against the new token names in `admin-theme.ts` (the CSS custom properties were renamed, e.g. `--cimisy-charcoal` → `--cimisy-text`, `--cimisy-purple` → `--cimisy-accent`).

## 2.0.2

### Patch Changes

- adb2d28: Admin content tree: top-level collections and singletons with a `previewPath` are now grouped by route, the same way an explicit `page({ route })` block already is — a `previewPath: "/blog/:slug"` collection or a `previewPath: "/about"` singleton declared outside any `page()` now renders under a labeled route group instead of a bare, context-free card. If the derived route matches an existing `page({ route })`'s route, the item merges into that page's group instead of creating a duplicate. Entities with no `previewPath` are unaffected. Purely a grouping change in `buildAdminManifest` — no config shape changes, nothing to migrate.

## 2.0.1

### Patch Changes

- 0698df8: Security hardening pass: fixes a TOCTOU race in the local storage adapter, closes a media-upload gap, adds login rate limiting, and enforces a minimum session-secret length.

  **Breaking for existing deployments — action required before upgrading:** `githubSource({ sessionSecret })` now throws `WEAK_SESSION_SECRET` at construction time if `sessionSecret` is shorter than 32 characters (or missing). This is the key that signs the admin session cookie — a short one is brute-forceable. Generate a proper one with `openssl rand -base64 32` and update your deployment's `CIMISY_SESSION_SECRET` (or equivalent) before upgrading, or the app will fail to start.

  Other fixes:

  - **TOCTOU race in `LocalStorageAdapter.list()`** (CodeQL CWE-367): replaced the `stat()`-then-`readFile()` pattern, where a file could change or disappear between the two calls, with a direct `readFile()` per entry that skips `ENOENT`/`EISDIR` — the same check-free idiom already used by `read()`.
  - **Unvalidated `targetKey` on media upload**: `POST /api/cimisy/media` now 404s if `targetKey` doesn't match a declared collection or singleton, closing a gap where a writer could mint draft branches/PRs for content keys that don't exist in config.
  - **`/auth/login` now rate-limited**, the same IP-keyed limiter already applied to `/auth/callback`.
  - Dev/example dependency bumps clearing ~60 Dependabot alerts (none were in the package's published runtime dependencies): `next` to `^15.5.16`, `vitest` to `^3.2.6`, plus `postcss`/`esbuild`/`vite` pinned via `pnpm.overrides` where transitive resolution still lagged. The `next` peer range is unchanged (`>=14.0.0`). The two example apps' route handlers and internal library types were updated for Next 15's Promise-based route `params`, and a couple of internal nav links were switched to `next/link` to satisfy `eslint-config-next`'s `no-html-link-for-pages` rule.

## 2.0.0

### Major Changes

- 85daeda: The editor experience gets real, and content gets a shape. A rich Tiptap-based block editor, media upload, an in-CMS drafts/review screen, and a live preview pane close the biggest gaps in day-to-day editing; a new page/section/collection hierarchy plus finally-wired-up singletons let content be organized the way real sites actually are; and a new `cimisy/seo` export adds per-entry SEO fields, a one-call `generateMetadata` helper, and hardened JSON-LD builders.

  ## The editor experience

  **Rich inline text.** Paragraph and callout blocks now carry `content: InlineNode[]` (bold/italic/inline-code/links) instead of a flat `text: string`. Old `{ text }` payloads from in-flight 1.x clients are transparently upgraded on write; on-disk `.mdx` files need no migration — content is rebuilt from the file on every read. If you render blocks yourself via `cimisy/render`, `Paragraph`/`Callout` component props changed from `{ text }` to `{ content: InlineNode[] }` — pass your own component in the `components` map if you need the old shape, or use the updated default.

  **Media upload.** New `fields.image({ directory })` uploads go through `POST /api/cimisy/media`, land in the configured directory, and commit through the same draft-vs-direct-publish path as an entry save. Custom `StorageAdapter` implementations gain two new optional capabilities — `readRaw` (raw bytes, for serving uploaded images back through the admin UI) and `listChangeRequests` (for the Drafts screen below); implement both to get full media/drafts support, or omit them to degrade gracefully (uploads disabled, Drafts screen empty). `ChangeRequest.writes` items gained an optional `encoding: "utf-8" | "base64"` (defaults to `"utf-8"`, matching all prior behavior) — a custom adapter must handle `"base64"` to support uploads.

  **Drafts screen.** A new "Drafts" nav item (shown when the adapter reports PR support) lists open drafts — your own, plus anyone's you can `publish`. Reviewers get a live preview of the draft (previewing someone else's in-progress branch, not just your own) and an "Approve & merge" button. This is the first release where the `publish` role action (declared since 1.1.0's RBAC work but never enforced) actually gates something: merging.

  **Live preview pane.** The entry editor has a "Show preview" toggle rendering the collection's `previewPath` in a side-by-side iframe, refreshed on save. It shows the last _saved_ state, not unsaved edits in progress — save to refresh it.

  ## Content hierarchy and singletons

  **Page/section/collection hierarchy.** New `page()` and `section()` config primitives: a `page({ label, path?, route?, sections })` groups the content that renders on one route — `section()` for static one-file content, `collection()` (whose `path` is now optional inside a page — derived as `<pagePath>/<key>/*.mdx`) for repeating entries. Content lives in nested directories mirroring the hierarchy (e.g. `content/pages/home/hero.yaml`, `content/pages/home/testimonials/*.mdx`), the admin home screen renders the tree, and the reader exposes it as `reader.pages.<page>.<section>`. Every content target gets a flat dot-joined key (`posts`, `home.hero`) used in admin URLs, API routes, and draft-branch names — draft branches from a flat, pre-hierarchy config still parse and merge. RBAC is unchanged: rules still match real repo paths, so `{ path: "content/pages/home/**", actions: [...] }` scopes a role to one page's subtree.

  **Singletons, wired end-to-end.** `singleton()` existed as a config type since 1.0 but nothing consumed it. It now works everywhere: `GET/PUT /api/cimisy/singletons/<key>` (with baseVersion optimistic concurrency and per-path RBAC), `reader.singletons.<key>.get()` (null until first saved — declaring one in config is all it takes to make it editable), an admin form with the same publish/draft/conflict/history/preview affordances as entries, and draft/PR parity (singleton drafts use the reserved branch slug `singleton`, e.g. `cimisy/alice/settings/singleton`). All-frontmatter singletons store as plain YAML (no `---` fences); schemas with a `fields.blocks()` body store as MDX — derived automatically, overridable via `format`, fail-closed on mismatch. `singleton()` now requires a `label` and accepts `previewPath`.

  ## SEO (`cimisy/seo`, new export)

  `fields.seo({ imageDirectory? })` adds a collapsed per-entry SEO panel (title/description with character-count hints, canonical, og:image via the standard media pipeline, noindex) stored as one nested frontmatter mapping — `canonical` is schema-refined to `https://` or site-relative (no `javascript:` by construction), `ogImage` gets the same no-`..` refine as `fields.image`. `createMetadata({ seo, fallback, defaults, path })` turns it into a Next.js `Metadata` object with entry-value > entry-fallback > site-default precedence (title template, canonical resolution against `siteUrl`, Open Graph, Twitter, `robots` from noindex). `seoSettingsFields()` + `seoDefaultsFromSettings()` establish the conventional site-settings singleton those defaults come from. `articleJsonLd`/`breadcrumbListJsonLd`/`organizationJsonLd`/`webSiteJsonLd` + `<JsonLd>` render schema.org structured data with `</script>`-breakout-safe serialization (CMS-edited strings flow into it) and an `overrides` hook for CMS-editable extras. The export is separate from `cimisy/next` so `<JsonLd>` works in client components and none of it pulls `server-only`.

  ## Upgrade notes (breaking)

  - Flat configs (no `pages`) keep working unchanged: same keys, same on-disk paths, same RBAC rules, same `reader.collections.*` — the hierarchy is additive. Existing `singleton()` declarations need a `label` added (and now actually do something).
  - Content keys (collection/singleton/page names in config) must now be lowercase kebab-case (`[a-z0-9-]`, dot-joined segments internally) and may not be `team`, `drafts`, `pages`, or `new` — they become admin URLs and git-ref components. A camelCase collection key must be renamed.
  - `AdminManifest` reshaped: `collections: CollectionManifest[]` → `tree: ManifestTreeNode[]` + `byKey: Record<string, EntityManifest>`; entity manifests carry `kind: "collection" | "singleton"` and `key` (replacing `name`). It also gained `draftsSupported: boolean`, and `FieldManifest` gained an optional `directory` (image/seo fields) and `richTextProp`/updated `blockTypes[].richTextProp`.
  - Media upload body field `collectionName` → `targetKey`; the drafts API rows renamed `collectionName` → `contentKey` and gained `kind: "collection" | "singleton"`.
  - `createCimisyHandler`/`createReader`/`buildAdminManifest` now type their parameter as `ResolvedCimisyConfig` (what `config()` returns) — pass your config through `config()`, which you already do if you followed the docs.
  - Internal stores (`collection-store`, new `singleton-store`) consume the normalized `NormalizedCollection`/`NormalizedSingleton` shapes from `config()` — only relevant if you imported those internals directly.
  - The admin UI's root container widened from 760px to 960px to fit the live preview pane's side-by-side layout — if you've overridden `.cimisy-root` styles, re-check the width assumption.
  - New dependencies: `@tiptap/core`, `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `@tiptap/suggestion` — all admin-UI-only (imported exclusively from `react/admin/editor/*`), never loaded by the `cimisy/render` or server-side exports.

## 1.1.0

### Minor Changes

- d007582: Add admin-managed user roles on top of GitHub auth. GitHub sign-in now creates a pending user record instead of deriving role from live collaborator permission on every request. The first sign-in bootstraps as admin (repo owner in the common case); every person after that starts pending until an existing admin assigns a role from the new Team screen.

  Adds a `publisher` (direct-publish) role alongside `editor`, a `manageUsers` action, and a zero-admin lockout guard on role changes.

  **Upgrade note for existing GitHub-source deployments:** the user roster (`.cimisy/users.yaml`) starts empty. The next person to sign in bootstraps as admin if their live GitHub collaborator permission maps to `admin`; everyone else lands pending until an admin assigns them a role from the Team screen. If the next sign-in isn't a repo admin, sign in as one first to bootstrap access before anyone else logs in.

  Also refines the admin UI: a persistent top nav (replacing the old corner auth bar), a "waiting for access" screen for pending users, and the new Team screen for managing roles.

## 1.0.0

### Major Changes

- Initial public v1 release: config engine, local + GitHub storage adapters, GitHub App auth, layered RBAC with branch/PR draft workflow, safe MDX block editor with an AST allowlist validator, Draft Mode preview via a typed Reader API, and a security hardening pass (CSRF, rate limiting, path-traversal fuzz coverage, activity log).
