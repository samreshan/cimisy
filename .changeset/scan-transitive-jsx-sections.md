---
"cimisy": patch
---

Fix `cimisy scan` only resolving JSX components one hop deep from the route file. `runScan` called `findJsxSections` exactly once, against the literal `page.tsx`/`.jsx` — so a component it rendered (e.g. `LeadershipPage`) was scanned for arrays, but any component *that* component rendered (e.g. `LeadershipGrid`) never was. This is invisible for a page that renders its content directly, but breaks the common `page.tsx` (thin, Next.js-required route file) → `XxxPage.tsx` (the real page) → individual section components convention — anything past the first hop was structurally unreachable regardless of whether its array was declared locally or imported from a data module (see the previous patch's cross-file resolution).

`runScan` now BFSes: it calls `findJsxSections` on the route file, then again on every newly-resolved component file, repeating until nothing new turns up, guarding against import cycles with a visited set. A candidate's `section` is now the deepest component that actually renders it, not necessarily the page's direct child.
