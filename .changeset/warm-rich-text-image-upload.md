---
"cimisy": patch
---

Fixed: the rich-text block editor's "Image" block had no way to actually attach an image — its NodeView only showed a thumbnail (if `src` was already set) or a placeholder telling you to "use the Image props form," which doesn't exist for a block wired into the Tiptap editor. There was no upload button, no browse-existing picker, and no drag-and-drop — a genuine dead end for `fields.blocks({ blocks: { image: blocks.image() } })` usage.

The Image block's NodeView now has the same "Upload…"/"Replace…" and "Browse existing…" controls as `fields.image()`'s `ImageField`, reusing the identical `POST /media` upload flow. `blocks.image()` gains an optional `directory` option (matching `fields.image()`'s required one) that both enables these controls and registers the directory with `getConfiguredImageDirectories`, so uploads pass the server's directory allowlist; omitting `directory` leaves the block's upload/browse controls disabled with an inline explanation, rather than guessing at an implicit location.
