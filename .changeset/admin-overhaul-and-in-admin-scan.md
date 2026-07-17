---
"cimisy": minor
---

Admin UI/UX overhaul plus a dev-only in-admin scan/import surface — v2.4.0.

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
