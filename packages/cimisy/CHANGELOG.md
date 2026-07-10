# cimisy

## 1.1.0

### Minor Changes

- d007582: Add admin-managed user roles on top of GitHub auth. GitHub sign-in now creates a pending user record instead of deriving role from live collaborator permission on every request. The first sign-in bootstraps as admin (repo owner in the common case); every person after that starts pending until an existing admin assigns a role from the new Team screen.

  Adds a `publisher` (direct-publish) role alongside `editor`, a `manageUsers` action, and a zero-admin lockout guard on role changes.

  **Upgrade note for existing GitHub-source deployments:** the user roster (`.cimisy/users.yaml`) starts empty. The next person to sign in bootstraps as admin if their live GitHub collaborator permission maps to `admin`; everyone else lands pending until an admin assigns them a role from the Team screen. If the next sign-in isn't a repo admin, sign in as one first to bootstrap access before anyone else logs in.

  Also refines the admin UI: a persistent top nav (replacing the old corner auth bar), a "waiting for access" screen for pending users, and the new Team screen for managing roles.

## 1.0.0

### Major Changes

- Initial public v1 release: config engine, local + GitHub storage adapters, GitHub App auth, layered RBAC with branch/PR draft workflow, safe MDX block editor with an AST allowlist validator, Draft Mode preview via a typed Reader API, and a security hardening pass (CSRF, rate limiting, path-traversal fuzz coverage, activity log).
