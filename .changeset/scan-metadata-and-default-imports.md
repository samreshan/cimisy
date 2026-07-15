---
"cimisy": patch
---

Fix two `cimisy scan` gaps found while auditing a real app's coverage:

- **Default-imported arrays were invisible.** `resolveImportedArrayDeclaration` only followed plain named imports (`import { leaders } from "..."`) one hop to their declaration — a default import (`import chaptersRaw from "../data/about-timeline.json"`, or a plain `export default [...]` data module) was silently skipped, even though `.json` data imports are always default imports under webpack/Next's JSON interop. `cimisy scan` (and `--full`) now resolves both shapes, and `cimisy import`'s codemod cleans up the resulting default-import binding (or deletes the `.json` file outright, since its whole content is the array) the same way it already did for named imports.
- **Page-level SEO metadata was never scanned.** Every Next.js App Router page can export `export const metadata = { title, description, openGraph: { url } }` for its SEO — `cimisy scan --full` now detects this (mirroring `findStaticContent`'s "detect but don't guess" posture: a non-literal field is reported as unanalyzable, not dropped) and lists it in the report as `pageMetadataCandidates`/`pageMetadataUnanalyzable`. This is reporting-only for now — `cimisy import` doesn't yet offer these for automatic migration into a `fields.seo()` singleton.
