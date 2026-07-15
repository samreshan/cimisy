---
"cimisy": patch
---

Fix the admin UI's `fields.array()` editor (used for tags/list-style fields) rendering blank when opening an existing entry. `FieldInput` had no case for `kind === "array"`, so it fell through to the plain-text branch, which coerced the array value to `""` for display — the data was never lost (an untouched Save round-tripped the original array unchanged), but an editor had no way to see or edit existing list items. Adds a dedicated `ArrayField` component: a reorderable list of text inputs with add/remove/move controls.
