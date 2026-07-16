# cimisy — upcoming work after v2.3.0

Written 2026-07-16, immediately after the v2.3.0 work landed in the working tree
(whole-site scan modes + metadata import + CI gate + admin P0 fixes; changeset
`.changeset/whole-site-scan-and-admin-p0-fixes.md`). This file records the agreed
release sequence and the concrete backlog for each release, so the next session
can pick up without re-auditing.

**Agreed sequence (user decision, 2026-07-16):**

1. **v2.4.0 — admin UI/UX overhaul + dev-only in-admin scan/import surface**
2. **v2.5.0 (or v2.4.x) — `cimisy setup github` wizard via GitHub's App Manifest flow**
3. Later / opportunistic: items in the "Deferred" section at the bottom.

---

## 1. v2.4.0 — Admin UI/UX overhaul

User's stated priorities: **editor experience**, **visual polish & responsiveness**,
**onboarding & setup flow**, and *"simple configuration via UI where admins can scan
and import via UI and no need to touch the terminal too much."*

The P0 data-loss items (unsaved-changes guard, delete UI, field-level validation,
fetch error/retry) already shipped in v2.3.0 — do not redo them.

### 1a. In-admin scan/import surface (dev-only, full power)

Decision already made with the user: the scan UI appears **only when running
locally** (local adapter / dev mode) because scan/import rewrites source files and
a production server has no writable source repo. In production the section is
hidden entirely (the "read-only report in production" variant was considered and
rejected).

Design sketch grounded in what exists:

- The CLI already caches a machine-readable report at `.cimisy/scan-report.json`
  (`packages/cimisy/src/scan/report.ts` — `saveScanReport`/`loadScanReport`,
  `reportVersion: 1`, `mode` stamped). `toPortableReport()` exists for
  path-relativized output. Reuse these; do not invent a second report format.
- New admin route (reserved key, e.g. `/admin/scan`) gated server-side: only
  render/serve when the source is the local adapter AND `NODE_ENV !== "production"`.
  Add the key to `RESERVED_TOP_LEVEL_KEYS` in `config/define-config.ts` and the
  mirror in `scan/infer-static-schema.ts` (they're deliberately duplicated).
- API routes on the existing `createCimisyHandler` dispatcher
  (`next/route-handler.ts`): `POST /scan` (runs `runScan` with a mode picked in
  the UI; server-side it can import the scan module directly — no child process
  needed), `GET /scan/report` (last cached report), `POST /scan/import` (applies
  selected candidates via `applyCandidate` / `applyStaticCandidate` /
  `applyPageMetadataCandidate`). Guard all three with the same local-only check
  plus `requireSameOrigin` on the writes.
- Import safety in the UI must mirror the CLI: refuse when not a git repo /
  dirty working tree (surface the same messages `runImportCommand` prints), and
  create the same `cimisy/import-<timestamp>` branch. Consider running the apply
  functions in-process (they're plain async functions) but shelling out to `git`
  the same way `cli/index.ts` does (`isGitRepo`, `isWorkingTreeClean`,
  `createImportBranch` — extract these into a shared module instead of copying).
- UI: mode picker (the four modes), results grouped exactly like
  `printScanReport`'s sections (collection candidates / static / metadata / each
  "not import-eligible" bucket with reasons), checkboxes, one "Import selected"
  action, per-candidate success/failure display mirroring the CLI spinner output.

### 1b. Editor experience

From the v2.3.0 audit (all confirmed in code, file references still valid):

- **Autosave / local draft persistence** — nothing is persisted between sessions;
  a crash loses work even with the new beforeunload guard. Localstorage-keyed
  draft snapshot per entry (`entry-form.tsx` values state) with a "restore
  unsaved draft?" prompt on load is the minimal honest version.
- **Cmd/Ctrl+S to save** — no app-level keyboard shortcuts exist at all. Wire to
  the existing `handleSubmit`.
- **Drag-and-drop block reordering** — `editor/block-editor.tsx` lines ~119-204:
  reordering is up/down buttons in a separate "outline" list (documented
  deliberate scope trim). Replace/augment with DnD in the Tiptap editor.
- **Callout tone switching in the editor** — `editor/nodes.tsx` ~206-215: the
  tone `<select>` is deliberately `disabled`; only the fallback props form can
  change it. Make it live.
- **Headings with inline marks** — `editor/nodes.tsx` ~51-59: headings are
  `content: "text*"`, so bold/italic silently don't work in headings.
- **Live preview honesty** — preview iframe shows last-saved state only
  (`previewKey` bumps on save). Either debounce-save-to-draft for live preview or
  make the "preview reflects last save" state clearer than the current badge.
- **More field types** — boolean (the scanner already warns about
  boolean-to-string coercion — `infer-schema.ts:92-108` — a real
  `fields.boolean()` would remove that whole caveat), number, select/enum,
  multiline text; generalize `array-field.tsx` beyond text-only items
  (documented limitation in its header comment).
- **Media library screen** — media is only reachable inside an image field's
  "Browse existing…" picker (`image-field.tsx`). A standalone `/admin/media`
  screen (browse/upload/delete/reuse) is the missing piece. Also: drag-and-drop
  upload, progress feedback, alt-text prompt at upload time.

### 1c. Visual polish & responsiveness

- **Loading skeletons** replacing every bare `<p class="cimisy-muted">Loading…</p>`
  (app.tsx, entry-form, singleton-form, collections, drafts, team, block-editor) —
  preserve layout to kill CLS.
- **Mobile/responsive overhaul** — exactly one `@media (max-width: 860px)` block
  exists (`admin-theme.ts` ~906-921). Needs: a mobile nav pattern for `TopNav`
  (currently just flex-wrap), media-grid/team-row adaptations, testing <400px.
- **Consolidate inline `style={{…}}`** into the token system — inline styles are
  scattered through nearly every component and drift from the tokens.
- **Reconsider the blanket transition rule** — `.cimisy-root * { transition: … }`
  (admin-theme.ts ~121-123) applies transitions to every element; perf smell and
  makes everything feel slightly laggy.
- **Accessibility pass** — v2.3.0 added `role="alert"` on the entry form's error
  banner and `aria-invalid` on text inputs; the rest remains: `aria-live` on the
  other screens' banners, meaningful `alt` on content images (image-field uses
  `alt=""` always), announce loading states, don't convey badge status by dot
  color alone, label the remaining icon-only ↑/↓/Remove buttons.
- **Richer empty states and a dashboard home** — `ContentTree` is a flat card
  tree with no counts/recent activity; empty states are single text lines with
  no CTA.
- **Search/filter/sort/pagination on `EntryList`** — still renders the full
  unpaginated list with no search box; won't scale past ~50 entries.

### 1d. Onboarding & setup flow

- First-run experience: when the admin loads with zero content, guide toward
  creating the first entry — and (dev-only) toward the scan surface ("you have
  hardcoded content on 5 routes — import it?" using the cached report if present).
- Clearer errors when config/env is wrong (bad session secret length, missing
  GitHub env vars) — today these surface as raw 500s/generic banners.
- In-admin help affordances (what's a draft, what does the branch chip mean).

### v2.4.0 mechanics

- One `minor` changeset. jsdom + @testing-library/react are already devDeps
  (added in v2.3.0) — use them for all interactive UI tests.
- The scan-surface API routes need THREAT_MODEL.md additions (new attack
  surface: an authenticated admin triggering source rewrites — mitigation is the
  dev-only + local-adapter-only gate, but write it down).

---

## 2. `cimisy setup github` — App Manifest flow wizard

Decision already made with the user: **CLI wizard using GitHub's official App
Manifest flow** (chosen over an in-admin guided setup and over a doctor-command-
only approach). Today the setup is a manual README walkthrough with 7 env vars
(`CIMISY_GITHUB_REPO`, `CIMISY_GITHUB_BRANCH`, `CIMISY_GITHUB_APP_ID`,
`CIMISY_GITHUB_APP_CLIENT_ID`, `CIMISY_GITHUB_APP_CLIENT_SECRET`,
`CIMISY_GITHUB_APP_PRIVATE_KEY`, `CIMISY_SESSION_SECRET`).

Flow design:

1. `npx cimisy setup github` — prompts for the target repo (`owner/repo`) and
   whether the app is for a personal account or an org.
2. Spins a temporary localhost HTTP server (random port) and opens the browser at
   `https://github.com/settings/apps/new?state=…` (or
   `/organizations/<org>/settings/apps/new`) with a **POSTed manifest** declaring:
   name, redirect URL (the temp server), callback URL
   (`<app-origin>/api/cimisy/auth/callback` — ask for the app origin or default
   `http://localhost:3000`), permissions (contents: write, pull requests: write,
   members: read — mirror what the README walkthrough asks for today), and
   `request_oauth_on_install` / identity settings matching the current OAuth use.
3. GitHub redirects back with a temporary `code`; exchange at
   `POST /app-manifests/{code}/conversions` → returns `id`, `client_id`,
   `client_secret`, `pem`, `html_url` in one shot.
4. Write `.env.local` (create or merge — never clobber unrelated keys), generate
   `CIMISY_SESSION_SECRET` (crypto-random ≥32 chars) if absent, and print the
   `html_url` install link.
5. Poll/verify installation: after the user installs the App on the repo, verify
   with the same `getRepoInstallation` path `GithubAppAuth` already implements
   (`src/github/app-auth.ts`) and confirm collaborator read works.
6. End with a doctor-style checklist (each env var present + verified) — factor
   this verification into a `cimisy doctor` subcommand so it's independently
   runnable later.

Implementation notes:

- Lives in `src/cli/` as a new command; reuse `CliUsageError`/exit-code
  conventions added in v2.3.0. The CLI entry guard (`isCliEntrypoint()` in
  `cli/index.ts`) already allows importing the module in tests.
- The manifest flow needs no PAT and no pre-existing credentials — that's the
  whole point. Do not persist the manifest `code` (single-use, expires in 1h).
- `.env.local` writing must be additive and idempotent; print a diff-style
  summary of what was written.
- Security: the temp server must bind localhost only, accept exactly one
  request, validate the `state` parameter it generated, and shut down
  immediately after.

---

## 3. Deferred / opportunistic backlog

Recorded during the v2.3.0 audit and planning; none are scheduled.

- **Scan**: MDX/markdown input scanning (needs a separate parser + candidate
  model — the analyzer stack is TS-AST-only); `generateMetadata()` static-return
  analysis; `default.*` parallel-route fallbacks; intercepting routes; baseline
  diff for CI (needs stable candidate identity across runs — byte offsets churn;
  regionHint+file breaks on renames — a real design, not a ride-along);
  `scan.include` config (rejected for v2.3.0 as under-specified vs `exclude`);
  relativize the on-disk report cache (re-absolutize in `loadScanReport`) so the
  cache itself is portable.
- **Import**: metadata import into site-wide SEO defaults for layout-level
  metadata (currently reported unanalyzable with a manual-migration hint);
  githubSource import targets (all apply paths are localSource-only);
  the known stale-offset gap when two collection candidates share one data
  module in a single run (`apply.ts:204-210`).
- **RBAC** (from the auth audit — everything else already exists and works):
  live GitHub→cimisy role sync (collaborator permission is consulted only for
  first-admin bootstrap; everyone else is manual roster assignment);
  GitHub org **team** → role mapping (`roleMapping` only handles the 5 permission
  levels); per-user role overrides; a structured audit log (today the "activity
  log" is git history — no login/denial/role-change event stream).
- **Infra**: multi-instance rate limiter guidance/adapters (in-memory default is
  documented as unsafe across serverless instances); the abstract `version`
  field anticipates a future DB adapter.
- **Editor tech debt**: `<blockquote>` flattens to plain paragraph (needs a
  dedicated quote/callout block); nested boundary tags absorbed into outer
  region ("v1 simplification" in analyze-static-content.ts); static image
  imports (non-string `src`) unsupported.

---

## Context that saves the next session time

- Publishing: Changesets → merge to `main` opens "Version Packages" PR → merging
  that publishes to npm with provenance. Two changesets are pending in the tree
  (the v2.3.0 minor + the earlier `fix-use-client-and-boolean-fields` patch).
- Tests: `pnpm run test` (vitest, packages/cimisy only). Interactive admin tests
  use `// @vitest-environment jsdom` per-file + @testing-library/react.
- `examples/next-local` now contains deliberately hardcoded scan bait
  (`app/about/page.tsx` with importable metadata + hero section, root layout
  footer) — dogfood the scan UI against it. `next build` of next-local failing
  with `LOCAL_ADAPTER_IN_PRODUCTION` is the guard rail working, not a bug.
- E2E pattern used for v2.3.0 verification (works well, reuse it): copy
  next-local to the scratchpad, `npm install` with a `file:` dep on the package
  (note: this symlinks — never `rm -rf node_modules/cimisy/dist`, it deletes the
  real build), `git init`, run the real CLI, then `tsc --noEmit` + `next dev` +
  curl to verify generated code and rendered output.
