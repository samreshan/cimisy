# cimisy

A git-based, security-first CMS that installs directly into an existing Next.js app. No hosted server, no database — content is plain MDX + YAML frontmatter, versioned in your own git repo (local disk in dev, GitHub in production). There is nothing to export because there was never any lock-in to begin with: the content was always just files in your repo.

- **No lock-in.** Delete the two route files and the config, and you're left with plain MDX/YAML content and a normal Next.js app — nothing to migrate.
- **Security-first.** Every write is authorized server-side against a centralized RBAC check (never a hidden UI button), all MDX is parsed through a strict AST allowlist (no `import`/`export`, no raw `{expression}` escape hatches, no unregistered JSX), and CSRF/rate-limiting/path-traversal protections are on by default. See [Security](#security) below.
- **Real multi-user roles.** GitHub's own collaborator permissions map to cimisy roles out of the box — admins/maintainers publish directly, other contributors get a branch + pull request per draft, reviewed and merged through GitHub itself.

## Table of contents

- [Quickstart (local adapter)](#quickstart-local-adapter)
- [Using the GitHub adapter](#using-the-github-adapter)
- [Setting up a GitHub App](#setting-up-a-github-app)
- [Config reference](#config-reference)
- [RBAC guide](#rbac-guide)
- [Reading content on your site](#reading-content-on-your-site)
- [Draft Mode / preview](#draft-mode--preview)
- [Security](#security)
- [Migrating to / away from cimisy](#migrating-to--away-from-cimisy)

## Quickstart (local adapter)

The local adapter needs no external setup and is the fastest way to see cimisy running — it writes directly to disk and refuses to run once `NODE_ENV=production`, so it's dev-only by design.

```sh
npm install cimisy
```

Create `cimisy.config.ts` at your project root:

```ts
import { blocks, collection, config, fields } from "cimisy/config";
import { localSource } from "cimisy/adapters/local";

export default config({
  source: localSource({ rootDir: "./content" }),

  collections: {
    posts: collection({
      label: "Blog posts",
      path: "posts/*.mdx",
      slugField: "slug",
      previewPath: "/blog/:slug",
      schema: {
        title: fields.text({ label: "Title", validation: { isRequired: true } }),
        slug: fields.slug({ source: "title" }),
        publishedAt: fields.date({ label: "Published at" }),
        body: fields.blocks({
          label: "Body",
          blocks: {
            heading: blocks.heading(),
            paragraph: blocks.paragraph(),
            image: blocks.image(),
            callout: blocks.callout({ tones: ["info", "warning", "danger"] }),
            code: blocks.code({ languages: ["ts", "js", "bash", "json"] }),
          },
        }),
      },
    }),
  },
});
```

Mount the admin UI at `app/(cimisy)/admin/[[...segments]]/page.tsx` (the route group keeps `/admin` off your public nav without affecting the URL):

```tsx
import { CimisyAdminPage } from "cimisy/next";
import cimisyConfig from "@/cimisy.config";

export default async function AdminPage({ params }: { params: Promise<{ segments?: string[] }> }) {
  const { segments } = await params;
  return (
    <CimisyAdminPage cimisyConfig={cimisyConfig} segments={segments ?? []} basePath="/admin" apiBasePath="/api/cimisy" />
  );
}
```

Mount its API route at `app/api/cimisy/[...route]/route.ts`:

```ts
import { createCimisyHandler } from "cimisy/next";
import cimisyConfig from "@/cimisy.config";

export const { GET, POST, PUT, DELETE } = createCimisyHandler(cimisyConfig);
```

Run your app and open `/admin` — create a post, and you'll see a real `.mdx` file appear under `./content/posts` with clean YAML frontmatter and MDX body.

## Using the GitHub adapter

Swap `localSource` for `githubSource` to write real commits (and, for non-admin roles, real branches + pull requests) to a GitHub repo instead of local disk:

```ts
import { githubSource } from "cimisy/adapters/github";

export default config({
  source: githubSource({
    repo: process.env.CIMISY_GITHUB_REPO!, // "owner/repo"
    branch: process.env.CIMISY_GITHUB_BRANCH ?? "main",
    appId: process.env.CIMISY_GITHUB_APP_ID!,
    privateKey: process.env.CIMISY_GITHUB_APP_PRIVATE_KEY!,
    clientId: process.env.CIMISY_GITHUB_APP_CLIENT_ID!,
    clientSecret: process.env.CIMISY_GITHUB_APP_CLIENT_SECRET!,
    sessionSecret: process.env.CIMISY_SESSION_SECRET!,
  }),
  // ...collections unchanged
});
```

This needs a GitHub App registered against your own account/org — cimisy never runs a shared App on your behalf, since that App's private key is effectively a write key to every repo it's installed on, and centralizing that across every cimisy user would make the cimisy project itself a single point of compromise. See the next section.

A typical `NODE_ENV`-based switch, so local dev still uses the zero-setup local adapter:

```ts
source:
  process.env.NODE_ENV === "development"
    ? localSource({ rootDir: "./content" })
    : githubSource({ /* ... */ }),
```

## Setting up a GitHub App

1. **Pick a repo.** It needs at least one commit already (an empty repo has no branch/ref for the adapter to read).
2. **Register the App** — GitHub → Settings → Developer settings → GitHub Apps → New GitHub App (use your org's settings instead of your personal ones for an org-owned repo).
   - **Homepage URL**: your app's URL (`http://localhost:3000` for local dev)
   - **Callback URL**: `<your-app-url>/api/cimisy/auth/callback`
   - **Webhook**: uncheck "Active" — not required
   - **Repository permissions**: Contents → **Read and write**, Pull requests → **Read and write** (Metadata read-only is checked automatically)
   - **Where can this GitHub App be installed?**: "Only on this account" is simplest to start
3. **Collect credentials** from the App's settings page:
   - App ID → `CIMISY_GITHUB_APP_ID`
   - Client ID → `CIMISY_GITHUB_APP_CLIENT_ID`
   - Client secrets → Generate new → `CIMISY_GITHUB_APP_CLIENT_SECRET`
   - Private keys → Generate a private key → paste the downloaded `.pem`'s full contents into `CIMISY_GITHUB_APP_PRIVATE_KEY` (real newlines or literal `\n` both work — cimisy normalizes either form)
4. **Install the App** on your repo from the App's settings page ("Install App" in the sidebar).
5. **Set a session secret**: `CIMISY_SESSION_SECRET`, any long random string (`openssl rand -base64 32`).

Once installed, what a signed-in user can do depends on their GitHub **collaborator permission level on that repo** (not just "are they signed in"): Admin/Maintain publish directly, Write drafts via branch + PR, Read/Triage are read-only, and non-collaborators are rejected even with a valid GitHub identity. See [RBAC guide](#rbac-guide) to customize this mapping.

A complete runnable example (including the `.env.local` template) lives at [`examples/next-github`](https://github.com/samreshan/cimisy/tree/main/examples/next-github) in the repo.

## Config reference

### `config(options)`

The top-level config object, from `cimisy/config`.

| Option | Type | Required | Notes |
|---|---|---|---|
| `source` | `StorageAdapter` | yes | `localSource(...)` or `githubSource(...)` |
| `collections` | `Record<string, CollectionDefinition>` | yes | see below |
| `singletons` | `Record<string, SingletonDefinition>` | no | single fixed-path documents (e.g. site settings) |
| `roles` | `Record<string, RoleDefinition>` | no | defaults to a built-in admin/editor/viewer set — see [RBAC guide](#rbac-guide) |
| `roleMapping` | `Record<string, string>` | no | GitHub permission level → role name; has a sane default |
| `rateLimiter` | `RateLimiter` | no | defaults to an in-memory limiter — see [Security](#security) |

### `collection(options)`

| Option | Type | Notes |
|---|---|---|
| `label` | `string` | shown in the admin UI |
| `path` | `string` | e.g. `"content/posts/*.mdx"` — a single-segment glob |
| `slugField` | `string` | name of a `fields.slug()` field in `schema`, used as the filename |
| `schema` | `Record<string, FieldDefinition>` | field definitions, see below |
| `previewPath` | `string` | optional, e.g. `"/blog/:slug"` — enables a "Preview" link in the admin UI |

### `singleton(options)`

Same shape as `collection`, minus `path` (a singleton is one fixed file, e.g. `"content/settings/site.yaml"`, not a glob) and `slugField`.

### `fields`

| Field | Produces | Options |
|---|---|---|
| `fields.text({ label, validation? })` | `string` | `validation.isRequired`, `validation.maxLength` |
| `fields.slug({ source })` | `string` | `source`: sibling field to auto-derive from; validated against the same safe-path rules used everywhere a slug becomes a file path |
| `fields.date({ label })` | `Date` | — |
| `fields.image({ label, directory })` | `string \| null` | `directory`: repo-relative path new uploads are written under |
| `fields.array(itemField)` | `T[]` | wraps any other field |
| `fields.blocks({ label?, blocks })` | `BlockNode[]` | `blocks`: a map of block name → `blocks.*` definition (below) — this is the rich-content/MDX body field |

### `blocks` (for `fields.blocks`)

Built-in block kinds, each returning a `BlockDefinition` that declares its own zod prop schema and exactly how it round-trips to an MDX/mdast node:

- `blocks.paragraph()`
- `blocks.heading({ levels? })`
- `blocks.code({ languages? })`
- `blocks.image()`
- `blocks.callout({ tones })` — e.g. `tones: ["info", "warning", "danger"]`

`paragraph`/`heading`/`code` serialize as native Markdown (no JSX needed — inert by construction). `image`/`callout` serialize as real JSX elements that map to actual React components you provide when rendering (see [Reading content on your site](#reading-content-on-your-site)). You are not limited to the built-ins — any object implementing the `BlockDefinition` interface (`propsSchema`, `toMdxNode`, `matches`, `extractProps`) can be registered the same way; this is what keeps the MDX write path free of string concatenation regardless of which blocks a project defines.

## RBAC guide

Authorization is two layers, both enforced server-side on every request — never inferred from what the UI happens to show:

**Layer 1 — GitHub's own collaborator permission** (only relevant with the GitHub adapter) seeds a cimisy role via `roleMapping`. Default:

```ts
{ admin: "admin", maintain: "admin", write: "editor", triage: "viewer", read: "viewer" }
```

**Layer 2 — cimisy roles**, each a `directPublish` flag plus a list of path-glob + action rules. Default:

```ts
{
  admin:  { directPublish: true,  rules: [{ path: "**", actions: ["read", "write", "publish", "manageSchema"] }] },
  editor: { directPublish: false, rules: [{ path: "**", actions: ["read", "write"] }] },
  viewer: { directPublish: false, rules: [{ path: "**", actions: ["read"] }] },
}
```

Override either or both in `config({ roles, roleMapping })` — for example, to restrict an `editor` role to one subdirectory:

```ts
roles: {
  admin:  { directPublish: true,  rules: [{ path: "**", actions: ["read", "write", "publish", "manageSchema"] }] },
  editor: { directPublish: false, rules: [{ path: "content/posts/**", actions: ["read", "write"] }] },
  viewer: { directPublish: false, rules: [{ path: "**", actions: ["read"] }] },
},
roleMapping: { admin: "admin", maintain: "admin", write: "editor", triage: "viewer", read: "viewer" },
```

Every rule check is deny-by-default — no matching rule means no access, full stop. This is enforced by one centralized function on the server (never duplicated per-route, and never satisfied by anything the client sends), so there's no per-endpoint place for an authorization check to be forgotten.

**Publishing:** `directPublish: true` roles commit straight to the default branch. Everyone else's saves land on a deterministic branch (`cimisy/<username>/<collection>/<slug>`) with an auto-opened pull request; repeated saves push more commits to the same branch/PR instead of duplicating it. Merging is intentionally *not* reimplemented by cimisy — that's GitHub's own PR review and branch protection; cimisy only opens the PR and links to it from the admin UI.

The local adapter has no concept of collaborator permissions (there's no GitHub to ask), so it always resolves to whatever role your `roleMapping` maps unauthenticated/local requests to — appropriate for its dev-only scope.

## Reading content on your site

`createReader(cimisyConfig)` (from `cimisy/next`) gives typed, draft-mode-aware read access — no auth, since this is what renders your site for any visitor, same as your CMS's public pages always have been:

```tsx
import { createReader } from "cimisy/next";
import { renderBlocks, type BlockNodeLike } from "cimisy/render";
import cimisyConfig from "@/cimisy.config";

const reader = createReader(cimisyConfig);

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await reader.collections.posts?.bySlug(slug);
  if (!post || post.error) notFound();

  const body = Array.isArray(post.values.body) ? (post.values.body as BlockNodeLike[]) : [];
  return (
    <main>
      <h1>{String(post.values.title)}</h1>
      {renderBlocks(body)}
    </main>
  );
}
```

`renderBlocks` renders the validated block tree directly to React — it does not re-serialize to MDX text and recompile, since the content is already validated by the time the Reader returns it. Sensible unstyled defaults ship for all built-in block kinds and are fully overridable per block type. A hand-edited file that never went through the admin UI is still rejected here (same AST allowlist validator as the write path) — the render boundary defends itself regardless of how content got into the repo.

`reader.collections.<name>.all()` lists every entry (parse/validation failures on individual files surface as `{ error }` on that entry rather than failing the whole list); `.bySlug(slug)` fetches one.

## Draft Mode / preview

If a collection sets `previewPath`, saved entries get a "Preview" link in the admin UI. For a `directPublish` role this just opens the live page; for a draft/PR role it enables Next.js Draft Mode against that specific draft branch, so the exact unmerged content renders on your real site route with no rebuild. Exit it via `/api/cimisy/preview/disable?redirectTo=<path>` (an open-redirect guard rejects any `redirectTo` that isn't a same-origin relative path).

## Security

cimisy holds write credentials to your repository, so security is treated as a first-class concern rather than an afterthought:

- **MDX is never trusted, regardless of source.** A strict AST allowlist rejects `import`/`export`, raw `{expression}` syntax, and any JSX tag/attribute not explicitly registered by your block definitions — enforced on every read, not just content that came through the editor.
- **Authorization is centralized and server-side.** One function gates every read/write/delete/history request; client-side UI state is never the boundary (a request forging `role`/`isAdmin` fields has zero effect).
- **CSRF protection**: `sameSite: "lax"` session cookies plus explicit `Origin`/`Referer` verification on every state-changing route.
- **Path-traversal defense-in-depth** at every layer that turns user input into a file path or git ref.
- **Rate limiting** on writes and the OAuth callback, with a pluggable interface — the shipped in-memory default is explicitly not safe across multiple serverless instances; supply your own `RateLimiter` backed by shared storage in that kind of deployment.
- Secrets (App private key, client secret, session secret) are imported only in modules marked `server-only`, so a client-bundle leak is a build error, not a runtime surprise.

Full write-up, including the specific threat model and what's explicitly out of scope for v1: [SECURITY.md](https://github.com/samreshan/cimisy/blob/main/SECURITY.md) and [THREAT_MODEL.md](https://github.com/samreshan/cimisy/blob/main/THREAT_MODEL.md). Report vulnerabilities via GitHub's private vulnerability reporting — not a public issue.

## Migrating to / away from cimisy

**Into cimisy:** point a collection's `path` at your existing MDX files (adjust their frontmatter to match your `schema`) — there's no importer/transform step because cimisy doesn't use a proprietary storage format to begin with.

**Away from cimisy:** delete the two route files (`app/(cimisy)/admin/...`, `app/api/cimisy/...`) and `cimisy.config.ts`. What's left in your repo is plain MDX files with YAML frontmatter and a normal Next.js app — there is no export step, because content was never stored anywhere other than your own repository in a human-readable format.

## License

Apache-2.0
