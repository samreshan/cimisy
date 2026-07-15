---
"cimisy": patch
---

Fix two more `cimisy import` correctness bugs found running it against a real app:

- **Codegen had zero awareness of `"use client"`.** `createReader` (`cimisy/next`) imports the `server-only` package, and every codemod path made the rewritten component's default export `async` — both are outright incompatible with a Client Component (`server-only` cannot load in a client bundle at all, and React doesn't support async Client Components regardless). `cimisy scan`/`cimisy import` now detect a file's `"use client"` directive and report its candidates as unanalyzable (`this file is a Client Component...`) instead of rewriting it into a page-breaking 500. Splitting such a file into a Server Component wrapper + inner Client Component is a bigger follow-up, not done here — this stops the crash safely in the meantime.
- **Boolean fields were coerced to text with the same generic note as numbers.** cimisy has no boolean field type, so a scanned `isPlaceholder: true` was proposed as `fields.text()` and stored as the literal string `"true"`/`"false"` — but unlike a number, this isn't display-safe: any non-empty string (including `"false"`) is truthy in JS, so a pre-existing `{field && <Badge/>}` check would render for both values after migrating, silently inverting whatever `false` meant. Boolean fields now get a distinct, explicit warning about this in the scan report, instead of the same "will be stored as text" note used for numbers.
