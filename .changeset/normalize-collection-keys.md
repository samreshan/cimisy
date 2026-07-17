---
"cimisy": patch
---

Fixed: `cimisy import` (CLI and in-admin) used the scanned variable name verbatim as the collection key, so a constant like `POSTS` or `teamMembers` produced a config cimisy's own runtime refused to load ("key is not valid — only lowercase letters, digits, and single hyphens"). Variable names are now normalized (`POSTS` → `posts`, `teamMembers` → `team-members`), reserved admin keys are suffixed (`team` → `team-collection`), and the rewritten source uses bracket access for hyphenated keys.
