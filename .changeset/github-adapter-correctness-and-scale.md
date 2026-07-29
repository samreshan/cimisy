---
"cimisy": patch
---

Four GitHub-adapter fixes for correctness and scale:

- **Directory listings no longer silently truncate at 1,000 entries.** `list()` now uses
  the Git Trees API (`{ref}:{path}` subtree fetch) instead of the Contents API, whose
  1,000-file directory cap is unpaginated and error-free — a collection's 1,001st entry
  simply didn't exist. Blob SHAs are identical across both APIs, so version tokens are
  unchanged.
- **Files over 1 MB no longer read as empty.** The Contents API returns `content: ""`
  (not an error) for blobs over 1 MB; `read()`/`readRaw()` now fall back to the Blobs API
  (good to 100 MB) and fail closed if content is still unavailable. Previously a >1 MB
  YAML singleton parsed as an all-defaults document and the next save overwrote the real
  file with defaults; >1 MB media decoded to zero bytes.
- **Multi-file commits are ~2K+5 → 5 requests.** Text content is now inlined into
  `createTree` instead of one `createBlob` POST per file, and the optimistic-concurrency
  precheck resolves all touched paths from one tree listing per directory instead of one
  read per file. This also stops multi-file commits burning GitHub's content-creation
  rate limit (80/min) K times faster than necessary.
- **`ChangeRequest.baseVersion` accepts a per-path map** (`{ path: expectedVersion }`)
  alongside the existing scalar form. A single scalar can never match several
  pre-existing files (each has its own version token), so atomic multi-file updates of
  existing files were previously inexpressible. Existing scalar callers are unchanged.

Also raises the declared `yaml` dependency floor to `^2.8.3` (CVE-2026-33532 affects
`>=2.0.0 <2.8.3`; the lockfile already resolved a safe version).
