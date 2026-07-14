---
"cimisy": patch
---

Admin content tree: top-level collections and singletons with a `previewPath` are now grouped by route, the same way an explicit `page({ route })` block already is — a `previewPath: "/blog/:slug"` collection or a `previewPath: "/about"` singleton declared outside any `page()` now renders under a labeled route group instead of a bare, context-free card. If the derived route matches an existing `page({ route })`'s route, the item merges into that page's group instead of creating a duplicate. Entities with no `previewPath` are unaffected. Purely a grouping change in `buildAdminManifest` — no config shape changes, nothing to migrate.
