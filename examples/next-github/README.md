# next-github — cimisy M2–M5 example

Demonstrates cimisy's GitHub-backed storage adapter, GitHub App authentication, layered RBAC with a branch/PR draft workflow, the block editor, and the public Reader API + Draft Mode preview. Unlike `examples/next-local`, this one needs real GitHub credentials before it will run — there's no way around that, since it authenticates against real github.com APIs.

## 1. Create a throwaway test repo

Use a repo you don't mind experimenting on. It needs at least one commit (an empty repo has no `main` branch/ref for the adapter to read).

## 2. Register a GitHub App

Go to **github.com → Settings → Developer settings → GitHub Apps → New GitHub App** (org-owned repos: use the org's settings instead of your personal ones).

- **GitHub App name**: anything unique, e.g. `cimisy-dev-yourname`
- **Homepage URL**: `http://localhost:3000`
- **Callback URL**: `http://localhost:3000/api/cimisy/auth/callback`
- **Webhook**: uncheck "Active" — not used until a later milestone
- **Repository permissions**:
  - Contents: **Read and write**
  - Pull requests: **Read and write**
  - Metadata: Read-only (checked automatically)
- **Where can this GitHub App be installed?**: "Only on this account" is simplest for local dev

Click **Create GitHub App**.

## 3. Collect credentials

On the App's settings page:

- **App ID** → `CIMISY_GITHUB_APP_ID`
- **Client ID** → `CIMISY_GITHUB_APP_CLIENT_ID`
- Under "Client secrets" → **Generate a new client secret** → `CIMISY_GITHUB_APP_CLIENT_SECRET`
- Under "Private keys" → **Generate a private key** → downloads a `.pem` file → paste its full contents into `CIMISY_GITHUB_APP_PRIVATE_KEY`

## 4. Install the App on your test repo

From the App's settings page, click **Install App** in the left sidebar, and select the repo from step 1.

## 5. Configure this example

```sh
cp .env.local.example .env.local
```

Fill in the values from steps 1–4, plus a session secret:

```sh
openssl rand -base64 32
```

## 6. Run it

From the repo root:

```sh
pnpm install
pnpm --filter cimisy build
pnpm --filter next-github dev
```

Open `http://localhost:3000/admin`, sign in with GitHub, and create a post.

What happens next depends on your GitHub collaborator permission level on the test repo (cimisy's default role mapping — see `cimisy.config.ts`'s comment for how to customize it):

- **Admin/Maintain** collaborators: the save lands as a real commit directly on the default branch — check `git log`/GitHub's commit history to confirm.
- **Write**-level collaborators: the save opens (or updates) a pull request on a branch named `cimisy/<your-username>/posts/<slug>` instead — the admin UI shows a link to it after saving. The default branch is untouched until someone with merge rights merges the PR through GitHub's own UI; cimisy doesn't add its own merge/approve button by design (see the plan's RBAC notes — it leans on GitHub's branch protection instead of reimplementing review).
- **Read/Triage**-level collaborators: read-only — writes are rejected with a 403.
- Non-collaborators on the repo: rejected with a 403 even though they're a valid GitHub identity (sign-in alone isn't enough; you also need to actually be added as a collaborator on the test repo).

To see both ends of this, add a second GitHub account as a collaborator on your test repo with **Write** access (not Admin), and sign in as that account in a private/incognito window.

## Viewing content and previewing drafts

Visit `http://localhost:3000/blog` for the public site — it reads through `createReader()` (no auth needed, same as any real visitor would see) and renders via `renderBlocks()`. From the admin panel, an entry that's been saved shows a **Preview** link; for a direct-publish role this just opens the live page, but for a PR-gated role it enables Next.js Draft Mode and shows you the unmerged draft branch's content on the real site route — no rebuild, no deploy. An "exit preview" link on the page clears it.

## What this milestone does and doesn't do yet

- Everything above is real: layered RBAC (GitHub collaborator permission → cimisy role → path-glob rules), the branch/PR draft workflow, idempotent re-saves, the block editor (paragraph/heading/code/image/callout), and Draft Mode preview.
- Not yet built: the M6/M7 work — security hardening pass, audit trail, and the public v1 release itself — see the root README.
