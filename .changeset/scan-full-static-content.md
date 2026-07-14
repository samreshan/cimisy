---
"cimisy": minor
---

`cimisy scan --full` now also detects static, non-repeating content — headings, rich-text paragraphs, images, and standalone links — grouped into sections at semantic HTML5 boundary tags (`<section>`, `<header>`, `<footer>`, etc.), with a fallback region per component when no boundary tag is present. `cimisy import` presents these alongside collection candidates in one combined picker; selecting one writes a real `.yaml`/`.mdx` entry via `writeSingleton`, splices a `singleton({...})` or `page({...}){ sections }` into `cimisy.config.ts`, and rewrites the source JSX to read from `reader.singletons.<key>`/`reader.pages.<pageKey>.<sectionKey>` — the same git-branch-review trust model as collection imports (clean working tree or `--allow-dirty`, a dedicated `cimisy/import-<timestamp>` branch, no runtime RBAC involved).

Detection is conservative by design, mirroring the existing array scanner: content mixed with a non-literal expression (`Welcome to {siteName}`, `{t("key")}`), conditionally rendered content (`{cond && <X/>}`, ternaries), and ESM-imported images (`import hero from "./hero.png"`) are reported as detected-but-not-eligible rather than guessed at. Only a narrow tag/prop allowlist is ever read as content (headings, `p`/`blockquote` rich text, `figcaption`, `span`, `img`/`Image`, `a`/`Link`) — `className`, `data-*`, `aria-*`, event handlers, and every other prop are never touched.

A component rendered from a single route becomes a page-scoped `section()`; the same component rendered from multiple routes (e.g. a shared `Footer`) becomes a top-level `singleton()` instead.

The admin content tree now separates a page's static content from its collections into two labeled groups instead of one flat list.

No breaking changes — `cimisy scan`/`cimisy import` without `--full` behave exactly as before.
