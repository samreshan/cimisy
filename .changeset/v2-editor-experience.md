---
"cimisy": major
---

v2: the editor experience. A rich Tiptap-based block editor (bold/italic/inline-code/links, slash-menu block insertion, block reordering), image upload with a browse-existing picker, an in-CMS drafts/review screen (preview + approve-and-merge), and a live preview pane — closing the biggest gaps in the day-to-day editing surface.

**Rich inline text.** Paragraph and callout blocks now carry `content: InlineNode[]` (bold/italic/inline-code/links) instead of a flat `text: string`. Old `{ text }` payloads from in-flight v1 clients are transparently upgraded on write; on-disk `.mdx` files need no migration — content is rebuilt from the file on every read. If you render blocks yourself via `cimisy/render`, `Paragraph`/`Callout` component props changed from `{ text }` to `{ content: InlineNode[] }` — pass your own component in the `components` map if you need the old shape, or use the updated default.

**Media upload.** New `fields.image({ directory })` uploads go through `POST /api/cimisy/media`, land in the configured directory, and commit through the same draft-vs-direct-publish path as an entry save. Custom `StorageAdapter` implementations gain two new optional capabilities — `readRaw` (raw bytes, for serving uploaded images back through the admin UI) and `listChangeRequests` (for the Drafts screen below); implement both to get full media/drafts support, or omit them to degrade gracefully (uploads disabled, Drafts screen empty). `ChangeRequest.writes` items gained an optional `encoding: "utf-8" | "base64"` (defaults to `"utf-8"`, matching all v1 behavior) — a custom adapter must handle `"base64"` to support uploads.

**Drafts screen.** A new "Drafts" nav item (shown when the adapter reports PR support) lists open drafts — your own, plus anyone's you can `publish`. Reviewers get a live preview of the draft (previewing someone else's in-progress branch, not just your own) and an "Approve & merge" button. This is the first release where the `publish` role action (declared since v1.1.0's RBAC work but never enforced) actually gates something: merging.

**Live preview pane.** The entry editor has a "Show preview" toggle rendering the collection's `previewPath` in a side-by-side iframe, refreshed on save. It shows the last *saved* state, not unsaved edits in progress — save to refresh it.

**Upgrade notes:**
- `AdminManifest` (from `next/manifest.ts`, if you consume it directly) gained `draftsSupported: boolean`; `FieldManifest` gained an optional `directory` (image fields) and `richTextProp`/updated `blockTypes[].richTextProp`.
- The admin UI's root container widened from 760px to 960px to fit the live preview pane's side-by-side layout — if you've overridden `.cimisy-root` styles, re-check the width assumption.
- New dependencies: `@tiptap/core`, `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `@tiptap/suggestion` — all admin-UI-only (imported exclusively from `react/admin/editor/*`), never loaded by the `cimisy/render` or server-side exports.
