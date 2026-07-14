# cimisy

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
