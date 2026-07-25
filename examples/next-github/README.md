# next-github — cimisy M2–M5 example

Demonstrates cimisy's GitHub-backed storage adapter, GitHub App authentication, layered RBAC with a branch/PR draft workflow, the block editor, and the public Reader API + Draft Mode preview. Unlike `examples/next-local`, this one needs real GitHub credentials before it will run — there's no way around that, since it authenticates against real github.com APIs.

## 1. Create a throwaway test repo

Use a repo you don't mind experimenting on. It needs at least one commit (an empty repo has no `main` branch/ref for the adapter to read).

## 2. Run the setup wizard

From this directory:

```sh
npx cimisy setup github
```

It asks for the repo from step 1 (and a production URL, which you can leave blank for local-only), opens your browser once to confirm a pre-filled GitHub App, then registers it, waits for you to install it on the repo, and writes `.env.local` itself — App id, private key, client id and secret, plus a freshly generated session secret. It finishes with a `cimisy doctor` checklist.

That's the whole of steps 2–5 of the old manual walkthrough. If you'd rather do it by hand — or the wizard can't open a browser on this machine — see [the package README's "Registering the App by hand" appendix](../../packages/cimisy/README.md#appendix-registering-the-app-by-hand), then `cp .env.local.example .env.local` and fill it in.

## 3. Check it

```sh
npx cimisy doctor
```

Prints a pass/fail line per check: env vars present, private key parses, App credentials accepted, App installed on the repo, Contents/Pull-requests permissions actually granted, branch exists, collaborator lookup works, routes mounted. Exits non-zero if anything failed, so it's usable in CI too.

## 4. Run it

From the repo root:

```sh
pnpm install
pnpm --filter cimisy build
pnpm --filter next-github dev
```

Open `http://localhost:3000/admin`, sign in with GitHub, and create a post.

What happens next depends on your GitHub collaborator permission level on the test repo (cimisy's default role mapping — see `cimisy.config.ts`'s comment for how to customize it):

- **Admin/Maintain** collaborators: the save lands as a real commit directly on the default branch — check `git log`/GitHub's commit history to confirm.
- **Write**-level collaborators: the save opens (or updates) a pull request on a branch named `cimisy/<your-username>/posts/<slug>` instead — the admin UI shows a link to it after saving. The default branch is untouched until the PR is merged: from the **Drafts** screen, anyone whose role is permitted to merge (server-decided, same RBAC path-glob rules as writes) sees an **Approve & merge** button that merges the PR directly through the GitHub adapter — no need to leave the admin UI, though merging straight from GitHub's own PR page works too.
- **Read/Triage**-level collaborators: read-only — writes are rejected with a 403.
- Non-collaborators on the repo: rejected with a 403 even though they're a valid GitHub identity (sign-in alone isn't enough; you also need to actually be added as a collaborator on the test repo).

To see both ends of this, add a second GitHub account as a collaborator on your test repo with **Write** access (not Admin), and sign in as that account in a private/incognito window.

## Viewing content and previewing drafts

Visit `http://localhost:3000/blog` for the public site — it reads through `createReader()` (no auth needed, same as any real visitor would see) and renders via `renderBlocks()`. From the admin panel, an entry that's been saved shows a **Preview** link; for a direct-publish role this just opens the live page, but for a PR-gated role it enables Next.js Draft Mode and shows you the unmerged draft branch's content on the real site route — no rebuild, no deploy. An "exit preview" link on the page clears it.

## What this milestone does and doesn't do yet

- Everything above is real: layered RBAC (GitHub collaborator permission → cimisy role → path-glob rules), the branch/PR draft workflow, idempotent re-saves, the block editor (paragraph/heading/code/image/callout), and Draft Mode preview.
- Not yet built: the M6/M7 work — security hardening pass, audit trail, and the public v1 release itself — see the root README.
