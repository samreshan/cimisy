# cimisy

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
