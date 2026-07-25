<p align="center">
  <img src="https://raw.githubusercontent.com/samreshan/cimisy/main/assets/cimisy-logo.png" alt="cimisy" height="56">
</p>

<p align="center"><strong>The CMS that moves into your repo.</strong></p>

A git-based, security-first CMS that installs directly into an existing Next.js app. No hosted server, no database — content is plain MDX + YAML frontmatter, versioned in your own git repo (local disk in dev, GitHub in production). There is nothing to export because there was never any lock-in to begin with: the content was always just files in your repo.

- **No lock-in.** Delete the two route files and the config, and you're left with plain MDX/YAML content and a normal Next.js app — nothing to migrate.
- **Security-first.** Every write is authorized server-side against a centralized RBAC check (never a hidden UI button), all MDX is parsed through a strict AST allowlist (no `import`/`export`, no raw `{expression}` escape hatches, no unregistered JSX), and CSRF/rate-limiting/path-traversal protections are on by default. See [Security](#security) below.
- **Real multi-user roles.** The repo owner bootstraps as admin on first sign-in and grants roles to everyone else from a Team screen — admins/publishers publish directly, editors get a branch + pull request per draft, reviewed and merged right from the admin UI (or GitHub itself).
- **A real editor.** Rich text (bold/italic/links/inline code) via a Tiptap-based block editor with slash-menu insertion, image upload, an in-CMS drafts/review screen, and a live preview pane.

## Table of contents

- [Quickstart (local adapter)](#quickstart-local-adapter)
- [Going to production (GitHub)](#going-to-production-github)
- [Environment variables](#environment-variables)
- [`cimisy doctor`](#cimisy-doctor)
- [Deploying to Vercel](#deploying-to-vercel)
- [Config reference](#config-reference)
- [Pages, sections & singletons](#pages-sections--singletons)
- [SEO](#seo)
- [RBAC guide](#rbac-guide)
- [Rich text & media](#rich-text--media)
- [Drafts & review](#drafts--review)
- [Reading content on your site](#reading-content-on-your-site)
- [Draft Mode / preview](#draft-mode--preview)
- [Security](#security)
- [Scanning & importing existing content](#scanning--importing-existing-content)
- [Migrating to / away from cimisy](#migrating-to--away-from-cimisy)
- [Appendix: registering the App by hand](#appendix-registering-the-app-by-hand)

## Quickstart (local adapter)

The local adapter needs no external setup and is the fastest way to see cimisy running — it writes directly to disk and refuses to run once `NODE_ENV=production`, so it's dev-only by design.

```sh
npm install cimisy
```

> **Shortcut:** `npx cimisy setup` scaffolds everything below automatically — the config file, the admin page, and the API route (skipping any that already exist). Migrating an existing site? Start with the full three-step flow instead: [Scanning & importing existing content](#scanning--importing-existing-content). The rest of this section shows the same files written by hand, so you know exactly what lands in your repo.

Create `cimisy.config.ts` at your project root:

```ts
import { blocks, collection, config, fields } from "cimisy/config";
import { resolveSourceFromEnv } from "cimisy/env";

export default config({
  // Local disk in dev; the GitHub adapter in production. The switch is an
  // environment variable, not a code change — see "Going to production".
  source: resolveSourceFromEnv({ contentDir: "./content", onIncomplete: "placeholder" }),

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

## Going to production (GitHub)

In production cimisy writes to a GitHub repo instead of local disk: real commits for direct-publish roles, real branches and pull requests for everyone else. That needs a GitHub App registered against your own account or org — cimisy never runs a shared App on your behalf, since that App's private key is effectively a write key to every repo it's installed on, and centralizing that across every cimisy user would make the cimisy project itself a single point of compromise.

Registering one used to be a fifteen-step walkthrough. Now:

```sh
npx cimisy setup github
```

It asks for the repo (`owner/repo`), whether that's a personal account or an org, and your production URL. Then it opens your browser once, on a **pre-filled** GitHub App confirmation page — permissions, callback URLs, and settings already chosen. You click Create, install the App on the repo, and the wizard:

- writes `.env.local` (additively — your other keys are untouched), including a freshly generated session secret,
- waits until the App is actually installed on the repo, then verifies it can read the repo and resolve collaborator permissions,
- prints **one** environment variable, `CIMISY_CONFIG`, to paste into your deployment platform,
- offers to set it on Vercel for you if the project is already linked,
- and finishes with a [`cimisy doctor`](#cimisy-doctor) checklist.

Both your production callback URL and `http://localhost:3000/api/cimisy/auth/callback` are registered up front, so local sign-in works too without a second trip to GitHub.

**The App must be owned by the same account that owns your content repo.** The wizard asks whether the owner is a personal account or an organization and registers the App in the right place, so this normally takes care of itself. If your repo lives in an org and you answer "personal account", the App will be created but you won't be able to install it on that repo. If you can't create Apps in the org, ask an owner to run the wizard, or to grant you the permission.

You never install someone else's App, and cimisy publishes none — the App is yours, private to your account, and its private key never leaves your deployment.

Prefer to do it by hand, or on a machine with no browser? See [Appendix: registering the App by hand](#appendix-registering-the-app-by-hand).

> `CIMISY_CONFIG` contains your App private key, client secret, and session secret. It's exactly as sensitive as the individual variables it replaces — paste it into a deployment platform's environment settings, never into an issue, a PR, or a chat.

## Environment variables

Your config file reads all of these through one call:

```ts
import { resolveSourceFromEnv } from "cimisy/env";

export default config({
  source: resolveSourceFromEnv({ contentDir: "./content", onIncomplete: "placeholder" }),
  // ...collections unchanged
});
```

With nothing set, that resolves to the local adapter rooted at `contentDir` — so the same file works in dev with no credentials at all. There are two ways to point it at GitHub.

**The one-variable form** (what the wizard prints):

| Variable | Notes |
|---|---|
| `CIMISY_CONFIG` | base64url blob carrying every value in the table below. Setting it selects the GitHub source on its own — no `CIMISY_SOURCE` needed. |

**The individual variables:**

| Variable | Required | Notes |
|---|---|---|
| `CIMISY_SOURCE` | yes | Set to `github` to opt in. Anything else (or unset) means the local adapter. |
| `CIMISY_GITHUB_REPO` | yes | `owner/repo` |
| `CIMISY_GITHUB_BRANCH` | no | Defaults to `main` |
| `CIMISY_GITHUB_APP_ID` | yes | |
| `CIMISY_GITHUB_APP_PRIVATE_KEY` | yes | PEM. Real newlines or `\n`-escaped on one line — cimisy normalizes either. |
| `CIMISY_GITHUB_APP_CLIENT_ID` | yes | |
| `CIMISY_GITHUB_APP_CLIENT_SECRET` | yes | |
| `CIMISY_SESSION_SECRET` | yes | ≥32 characters; signs the admin session cookie |
| `CIMISY_ALLOW_LOCAL_PROD` | no | `true` lets the local adapter run under `NODE_ENV=production`. Only for a controlled internal tool with its own access control in front. |

One more, independent of the two forms above and never part of the blob:

| Variable | Required | Notes |
|---|---|---|
| `CIMISY_PUBLIC_URL` | no | Your app's real public origin, e.g. `https://cms.example.com`. Only needed behind a proxy or custom domain that rewrites `Host`. On Vercel, `VERCEL_PROJECT_PRODUCTION_URL` is picked up automatically. Set it per-environment, never in `.env.local` — see [Deploying to Vercel](#deploying-to-vercel). |

`CIMISY_CONFIG` wins if both forms are set, and the two never merge — it's all-or-nothing, so there's always one answer to "which value is live?". cimisy logs a one-line warning when it finds both.

**`onIncomplete`** decides what happens when `CIMISY_SOURCE=github` but some variables are missing:

- `"throw"` (default) — the config throws at import, which fails the build. Fail-fast, if that's what you want.
- `"placeholder"` — the app still builds, the API answers `503` naming the missing variables, and `/admin` renders a page explaining exactly what to set and what this deployment's callback URL is. This is what `cimisy setup` scaffolds, because the person who hits this state is usually mid-deploy and needs to be told what's missing.

A malformed `CIMISY_CONFIG` throws under either setting — corrupt isn't the same as incomplete.

One caveat worth knowing before you rely on `"placeholder"`: it keeps the *app* building, but it can't invent content. If a public page statically prerenders content through [`createReader`](#reading-content-on-your-site), that page's build-time read still fails — there's no source to read from, and quietly prerendering an empty page would ship a silently-wrong site. Either make those routes dynamic (`export const dynamic = "force-dynamic"`) so they render per request once the variables land, or set `CIMISY_CONFIG` before the build that needs them. The `/admin` route and the API handler are unaffected: they're dynamic by nature and degrade to the instructions page and `503` respectively.

Explicit `githubSource({ ... })` calls still work exactly as before; `cimisy/env` is additive.

## `cimisy doctor`

```sh
npx cimisy doctor          # human-readable checklist
npx cimisy doctor --json   # machine-readable, for CI
```

Answers "is this actually configured, and will it work?" before your users do. It checks, each with a fix hint:

1. **Environment** — which source resolves and from which form, every required variable present, session secret long enough, and the private key parsed for real (the classic failure is a PEM whose newlines a hosting dashboard ate, which still *looks* like a PEM).
2. **GitHub App auth** — App JWT accepted, installation found on the repo.
3. **Repository** — Contents and Pull-requests permissions actually *granted* (the App requests them; whoever installs it can decline), the branch exists, collaborator-permission lookup works.
4. **Project wiring** — `cimisy.config` present, admin page and API route mounted.
5. **Rate limiting** — warns (never fails) when no shared store is configured, since the default limiter is per-instance and on serverless that quietly means no effective limit.

Exit code is `0` when everything passes, `1` if any check failed, `2` on CLI misuse. It reads `.env` and `.env.local` the way Next.js does, so it sees what your dev server sees.

## Deploying to Vercel

Two commands and one paste. Do it in this order — setting the variable *before* the first deploy is what makes it a two-step.

**1. Register the App and get your variable**

From your project directory, on your own machine:

```sh
npx cimisy setup github
```

Answer three questions (repo, personal-or-org, your Vercel URL), click **Create GitHub App** in the browser tab it opens, then install the App on your repo. It prints one line:

```
CIMISY_CONFIG=eyJ2IjoxLCJyZXBvIjoi…
```

**2. Put that variable on Vercel**

If the project is already linked (`vercel link`), the wizard offers to do this for you — say yes and skip ahead. Otherwise, either:

```sh
vercel env add CIMISY_CONFIG production
# paste the value when prompted
```

or **Vercel → your project → Settings → Environment Variables → Add**, name `CIMISY_CONFIG`, paste the value, scope it to **Production**.

**3. Deploy**

```sh
vercel --prod
```

Open `https://your-app.vercel.app/admin` and sign in with GitHub. You're the repo owner, so you bootstrap as admin automatically; everyone else who signs in starts pending until you give them a role from the **Team** screen.

That's it. `CIMISY_CONFIG` is the only variable cimisy needs — it carries the repo, App id, private key, client id and secret, and session secret. There's nothing else to configure, and no `vercel.json` to write.

Other hosts are the same shape: `netlify env:set CIMISY_CONFIG "<value>"`, `fly secrets set`, or whatever your platform calls environment settings.

### If something's off

| What you see | What it means |
|---|---|
| `/admin` shows a setup instructions page | The variable didn't reach this deployment. The page lists exactly which values are missing. Check it's scoped to the right environment, then **redeploy** — env vars only apply to a new build. |
| Build fails with `SOURCE_UNCONFIGURED` | Same cause, but a public page prerenders content through `createReader`, so the build can't finish without a source. Set the variable and redeploy, or make that page dynamic — see [Environment variables](#environment-variables). |
| GitHub says "redirect_uri is not associated with this application" | The URL you signed in from isn't a registered callback. See "Preview deployments" below. |
| Sign-in works, but you land on "pending" | Your GitHub collaborator permission on the content repo is below Admin/Maintain. See [RBAC guide](#rbac-guide). |

Run `npx cimisy doctor` locally at any point to check the same configuration from your terminal.

### Preview deployments

Every Vercel preview gets its own hostname, and GitHub Apps don't support wildcard callback URLs — so a preview's sign-in URL is never one you registered. cimisy handles this for you: it reads Vercel's `VERCEL_PROJECT_PRODUCTION_URL` and points the OAuth round trip at your **stable production domain**, so signing in from a preview lands you on production `/admin`. Content still comes from the same repo, so that's usually what you wanted.

If you'd rather each preview sign in against itself, add its URL to the App's callback list (max 10), or set `CIMISY_PUBLIC_URL` on that environment.

Behind a proxy or custom domain that rewrites `Host` — anywhere the server's view of the URL differs from the browser's — set `CIMISY_PUBLIC_URL` to your real public origin:

```
CIMISY_PUBLIC_URL=https://cms.example.com
```

Leave it unset otherwise; cimisy uses the request's own origin, which is right for a normal deployment. Don't put it in `.env.local` — pinning your local dev server to a production origin breaks localhost sign-in.

### A note on the rate limiter

Not about setup, but it matters in production: the default rate limiter is in-memory, so on serverless each instance gets its own bucket and the limit isn't really enforced. Pass your own `rateLimiter` backed by shared storage (Upstash, Vercel KV, Redis) for anything beyond a small single-instance deployment — see [Security](#security). `cimisy doctor` warns when it can't find one.

## Config reference

### `config(options)`

The top-level config object, from `cimisy/config`.

| Option | Type | Required | Notes |
|---|---|---|---|
| `source` | `StorageAdapter` | yes | usually `resolveSourceFromEnv({ contentDir })` from `cimisy/env` — see [Environment variables](#environment-variables). `localSource(...)` / `githubSource(...)` explicitly also work |
| `collections` | `Record<string, CollectionDefinition>` | no | top-level collections, see below |
| `singletons` | `Record<string, SingletonDefinition>` | no | single fixed-path documents (e.g. site settings) — see [Pages, sections & singletons](#pages-sections--singletons) |
| `pages` | `Record<string, PageDefinition>` | no | page → section/collection hierarchy — see [Pages, sections & singletons](#pages-sections--singletons) |
| `roles` | `Record<string, RoleDefinition>` | no | defaults to a built-in admin/publisher/editor/viewer set — see [RBAC guide](#rbac-guide) |
| `roleMapping` | `Record<string, string>` | no | GitHub permission level → role name, used only for first-admin bootstrap — see [RBAC guide](#rbac-guide) |
| `rateLimiter` | `RateLimiter` | no | defaults to an in-memory limiter — see [Security](#security) |
| `scan` | `ScanConfig` | no | defaults for the `cimisy scan` CLI (`{ mode?, exclude? }`) — see [Scanning & importing existing content](#scanning--importing-existing-content). No effect on the runtime admin/Reader. |

### `collection(options)`

| Option | Type | Notes |
|---|---|---|
| `label` | `string` | shown in the admin UI |
| `path` | `string?` | e.g. `"content/posts/*.mdx"` — a single-segment glob. Required for top-level collections; optional inside a `page()`, where it defaults to `"<pagePath>/<key>/*.mdx"` |
| `slugField` | `string` | name of a `fields.slug()` field in `schema`, used as the filename |
| `schema` | `Record<string, FieldDefinition>` | field definitions, see below |
| `previewPath` | `string` | optional, e.g. `"/blog/:slug"` — enables a "Preview" link in the admin UI |

Collection/singleton/page keys become admin URLs, API route segments, and draft-branch components, so they must be lowercase kebab-case (`my-posts`, not `myPosts`) and may not be `team`, `drafts`, `pages`, or `new` — `config()` rejects anything else at startup.

### `singleton(options)`

| Option | Type | Notes |
|---|---|---|
| `label` | `string` | shown in the admin UI |
| `path` | `string` | one fixed file, e.g. `"content/settings.yaml"` — not a glob, no slug |
| `schema` | `Record<string, FieldDefinition>` | field definitions |
| `format` | `"yaml" \| "mdx"?` | derived from the schema when omitted: `"mdx"` iff any field is a body field (`fields.blocks`), else plain YAML. `"yaml"` + a body field is a config-time error |
| `previewPath` | `string?` | a fixed route (no `:slug`) — enables the admin Preview link |

### `page(options)` / `section(options)`

See [Pages, sections & singletons](#pages-sections--singletons).

### `fields`

| Field | Produces | Options |
|---|---|---|
| `fields.text({ label, validation? })` | `string` | `validation.isRequired`, `validation.maxLength` |
| `fields.slug({ source })` | `string` | `source`: sibling field to auto-derive from; validated against the same safe-path rules used everywhere a slug becomes a file path |
| `fields.date({ label })` | `Date` | — |
| `fields.image({ label, directory })` | `string \| null` | `directory`: repo-relative path new uploads are written under; the admin UI renders an upload + browse-existing picker for this field — see [Rich text & media](#rich-text--media) |
| `fields.array(itemField)` | `T[]` | wraps any other field |
| `fields.blocks({ label?, blocks })` | `BlockNode[]` | `blocks`: a map of block name → `blocks.*` definition (below) — this is the rich-content/MDX body field |
| `fields.seo({ label?, imageDirectory? })` | `SeoValue` | a collapsed per-entry SEO panel (title/description/canonical/og:image/noindex) — see [SEO](#seo). `imageDirectory` enables the og:image upload picker |

### `blocks` (for `fields.blocks`)

Built-in block kinds, each returning a `BlockDefinition` that declares its own zod prop schema and exactly how it round-trips to an MDX/mdast node:

- `blocks.paragraph()`
- `blocks.heading({ levels? })`
- `blocks.code({ languages? })`
- `blocks.image()`
- `blocks.callout({ tones })` — e.g. `tones: ["info", "warning", "danger"]`

`paragraph`/`heading`/`code` serialize as native Markdown (no JSX needed — inert by construction). `image`/`callout` serialize as real JSX elements that map to actual React components you provide when rendering (see [Reading content on your site](#reading-content-on-your-site)). You are not limited to the built-ins — any object implementing the `BlockDefinition` interface (`propsSchema`, `toMdxNode`, `matches`, `extractProps`) can be registered the same way; this is what keeps the MDX write path free of string concatenation regardless of which blocks a project defines. A custom block type is still fully editable in the admin UI — the rich editor falls back to a generic props form for any block kind it doesn't have a dedicated node for.

`paragraph`/`callout` props carry rich inline text: `content: InlineNode[]` (a small recursive union — `text` / `strong` / `emphasis` / `inlineCode` / `link`), not a plain string. `heading`/`code` stay plain text/code strings — no bold/italic inside a heading or a fenced code block.

## Pages, sections & singletons

Real sites aren't one flat list of collections — a home page has a hero, some testimonials, maybe a feature grid. Pages and sections let the config say exactly that, and the admin UI mirrors it:

```ts
import { collection, config, fields, page, section, singleton } from "cimisy/config";

export default config({
  source: /* ... */,

  collections: {
    posts: collection({ /* top-level collections work exactly as before */ }),
  },

  // One fixed file, editable in the admin — declaring it is all it takes.
  singletons: {
    settings: singleton({
      label: "Site settings",
      path: "content/settings.yaml",
      schema: { siteName: fields.text({ label: "Site name" }) },
    }),
  },

  // A page groups the content that renders on one route.
  pages: {
    home: page({
      label: "Home",
      route: "/",                       // drives section preview links
      // path defaults to "content/pages/home"
      sections: {
        hero: section({                 // static content: one file
          label: "Hero",
          schema: { heading: fields.text({ label: "Heading" }) },
        }),
        testimonials: collection({      // repeating content: a directory
          label: "Testimonials",
          slugField: "slug",
          schema: { quote: fields.text({ label: "Quote" }), slug: fields.slug({ source: "quote" }) },
        }),
      },
    }),
  },
});
```

On disk this mirrors the hierarchy: `content/settings.yaml`, `content/pages/home/hero.yaml`, `content/pages/home/testimonials/<slug>.mdx`. Sections whose schema is all-frontmatter store as plain YAML (no `---` fences); add a `fields.blocks()` body and the file becomes MDX automatically.

Every content target gets a flat key — `posts`, `settings`, `home.hero`, `home.testimonials` — used in admin URLs (`/admin/home.hero`), API routes (`/api/cimisy/singletons/home.hero`), and draft branches (`cimisy/<user>/home.hero/singleton`). RBAC keeps matching real repo paths, so a rule of `{ path: "content/pages/home/**", actions: ["read", "write"] }` scopes a role to exactly one page's content.

Singletons get the full editing lifecycle: optimistic-concurrency saves, draft branches + PRs for non-`directPublish` roles (the Drafts screen lists them alongside entry drafts), history, and live preview via `previewPath` (sections inherit their page's `route`). A never-saved singleton renders as an empty create form — no seed file needed.

## SEO

Everything ships from the `cimisy/seo` export (separate from `cimisy/next` so it works in client components and never pulls `server-only`).

**Per-entry SEO panel.** Add `seo: fields.seo({ imageDirectory: "content/uploads" })` to any schema — entries get a collapsed panel with title/description (character-count hints), canonical URL (schema-validated: `https://` or site-relative only, `javascript:` impossible by construction), og:image through the standard media pipeline, and a noindex toggle.

**`generateMetadata` in one call.** Site-wide defaults live in the conventional settings singleton (`seoSettingsFields()` builds its schema); each page layers the entry's SEO value over its own title/image over those defaults:

```tsx
import { createMetadata, seoDefaultsFromSettings, type SeoValue } from "cimisy/seo";

export async function generateMetadata({ params }): Promise<Metadata> {
  const { slug } = await params;
  const [post, settings] = await Promise.all([
    reader.collections.posts?.bySlug(slug),
    reader.singletons.settings?.get(),
  ]);
  if (!post) return {};
  return createMetadata({
    seo: post.values.seo as SeoValue,
    fallback: { title: String(post.values.title) },
    defaults: seoDefaultsFromSettings(settings?.values),
    path: `/blog/${slug}`,
  });
}
```

That emits title (with the settings' `%s` title template), description, `alternates.canonical` (resolved against `siteUrl`), Open Graph, Twitter card, and `robots` from noindex.

**Structured data.** `articleJsonLd` / `breadcrumbListJsonLd` / `organizationJsonLd` / `webSiteJsonLd` build schema.org objects (each with an `overrides` hook for CMS-editable extras), and `<JsonLd data={...} />` renders them as `application/ld+json` with XSS-hardened serialization — a `</script>` payload typed into a CMS field cannot break out of the script element.

## RBAC guide

Authorization is admin-managed, not inferred from GitHub permissions on every request. A person's cimisy role lives in a roster committed to the repo (`.cimisy/users.yaml`), and every request checks it server-side — never inferred from what the UI happens to show.

**Bootstrap, then fully explicit.** The very first person to ever sign in becomes admin automatically if their live GitHub collaborator permission is admin-level (the practical stand-in for "the repo owner is the admin"). Every sign-in after that — by anyone — lands **pending** (no role) until an existing admin grants one from the **Team** screen (`/admin/team`). GitHub's collaborator permission is never consulted again once the roster is non-empty; `roleMapping` below only controls that one-time bootstrap check.

```ts
// Only relevant for the bootstrap check above:
roleMapping: { admin: "admin", maintain: "admin", write: "editor", triage: "viewer", read: "viewer" }
```

**Roles**, each a `directPublish` flag plus a list of path-glob + action rules. Default:

```ts
{
  admin:     { directPublish: true,  rules: [{ path: "**", actions: ["read", "write", "publish", "manageSchema", "manageUsers"] }] },
  publisher: { directPublish: true,  rules: [{ path: "**", actions: ["read", "write", "publish"] }] },
  editor:    { directPublish: false, rules: [{ path: "**", actions: ["read", "write"] }] },
  viewer:    { directPublish: false, rules: [{ path: "**", actions: ["read"] }] },
}
```

`publisher` and `editor` differ only in `directPublish` — an editor's saves always land on a draft branch + PR; a publisher's (like an admin's) commit straight to the default branch. `publish` gates merging someone else's draft from the [Drafts screen](#drafts--review); `manageUsers` gates the Team screen itself, with a built-in guard against leaving the roster with zero admins.

Override in `config({ roles, roleMapping })` — for example, to restrict `editor` to one subdirectory:

```ts
roles: {
  admin:     { directPublish: true,  rules: [{ path: "**", actions: ["read", "write", "publish", "manageSchema", "manageUsers"] }] },
  publisher: { directPublish: true,  rules: [{ path: "**", actions: ["read", "write", "publish"] }] },
  editor:    { directPublish: false, rules: [{ path: "content/posts/**", actions: ["read", "write"] }] },
  viewer:    { directPublish: false, rules: [{ path: "**", actions: ["read"] }] },
},
```

Every rule check is deny-by-default — no matching rule means no access, full stop. This is enforced by one centralized function on the server (never duplicated per-route, and never satisfied by anything the client sends), so there's no per-endpoint place for an authorization check to be forgotten.

**Publishing:** `directPublish: true` roles commit straight to the default branch. Everyone else's saves (and media uploads, and slash-menu edits — the same draft ref applies uniformly) land on a deterministic branch (`cimisy/<username>/<collection>/<slug>`) with an auto-opened pull request; repeated saves push more commits to the same branch/PR instead of duplicating it. Reviewing and merging can happen from the [Drafts screen](#drafts--review) inside cimisy, or on GitHub itself — cimisy never requires you to use one over the other.

The local adapter has no auth (there's no GitHub to sign in with), so every request acts as a fixed, full-access `local-admin` identity — appropriate for its dev-only scope; the roster/Team screen only apply to the GitHub adapter.

## Rich text & media

The block editor (a Tiptap/ProseMirror instance under the hood, admin-UI-only — nothing in `cimisy/render` or the server exports depends on it) supports:

- **Bold, italic, inline code, and links** — select text to get a formatting toolbar. A link's URL is validated (safe schemes only: `http:`, `https:`, `mailto:`, or relative) at the editor, on save, on read, and again at render time — four independent layers, since a `.mdx` file can always be hand-edited outside the UI.
- **Slash-menu block insertion** — type `/` to insert any block your `fields.blocks({ blocks })` registry declares, built-in or custom.
- **Block reordering** — a list beneath the editor with move-up/move-down/remove controls (deliberately not drag-and-drop; a wrong implementation there risks corrupting the document, and index-based reordering is exactly as capable).

For `fields.image()`, the admin UI renders a thumbnail, an "Upload…" button, and a "Browse existing…" picker over everything already uploaded to that field's `directory`. Uploads:

- are validated by their actual bytes (a PNG/JPEG/GIF/WEBP signature check), not by filename or client-claimed content type — this is an allowlist by construction, which is also why **SVG is not supported** (it can carry `<script>`);
- are capped at 5MB, checked before the payload is even base64-decoded;
- get a randomized filename (never the client-supplied one) to avoid both collisions and directory enumeration;
- land through the same draft-vs-direct-publish path as any other save — an editor's upload commits to their draft branch, not straight to the default branch.

A custom `StorageAdapter` needs to implement `readRaw` (serving an uploaded file's bytes back) and honor `encoding: "base64"` in `commitChange`'s `writes` to support uploads; both are optional, so an adapter without them just means uploads are unavailable, not a broken build.

## Drafts & review

For any adapter reporting pull-request support (the GitHub adapter; the local adapter has no PR concept), a **Drafts** nav item lists open drafts: your own, plus anyone's you have `publish` permission to review. Each draft shows its entry, its author, a **Preview** link (rendering that exact draft branch on your real site via Draft Mode — not just your own drafts, unlike the per-entry Preview link), a link to the underlying pull request, and — for reviewers — an **Approve & merge** button that merges it without leaving cimisy.

Nothing about drafts changes if you'd rather review on GitHub directly: the PR is real, cimisy's screen is just a second way to see and act on the same thing.

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

The reader also exposes singletons and the page hierarchy:

```ts
const settings = await reader.singletons.settings?.get();   // { version, values } | null (null until first saved)
const hero = await reader.pages.home?.hero.get();           // section → SingletonReader
const quotes = await reader.pages.home?.testimonials.all(); // nested collection → CollectionReader
```

## Draft Mode / preview

If a collection sets `previewPath`, the entry editor gets a "Show preview" toggle rendering that page in a side-by-side iframe. For a `directPublish` role this just shows the live page; for a draft/PR role it enables Next.js Draft Mode against that specific draft branch, so the exact unmerged content renders on your real site route with no rebuild. The pane shows the last *saved* state (reloading on every keystroke isn't practical) — a banner says so whenever there are unsaved changes.

The same mechanism, with an explicit `?ref=`, is what lets a reviewer preview *someone else's* draft from the [Drafts screen](#drafts--review) — the ref is validated as a well-formed draft branch for the exact entry being requested, and the reviewer still needs `read` permission on it, same as any other preview. Exit preview via `/api/cimisy/preview/disable?redirectTo=<path>` (an open-redirect guard rejects any `redirectTo` that isn't a same-origin relative path).

## Security

cimisy holds write credentials to your repository, so security is treated as a first-class concern rather than an afterthought:

- **MDX is never trusted, regardless of source.** A strict AST allowlist rejects `import`/`export`, raw `{expression}` syntax, and any JSX tag/attribute not explicitly registered by your block definitions — enforced on every read, not just content that came through the editor.
- **Authorization is centralized and server-side.** One function gates every read/write/delete/history request; client-side UI state is never the boundary (a request forging `role`/`isAdmin` fields has zero effect).
- **CSRF protection**: `sameSite: "lax"` session cookies plus explicit `Origin`/`Referer` verification on every state-changing route.
- **Path-traversal defense-in-depth** at every layer that turns user input into a file path or git ref.
- **Media uploads are format-sniffed, not trusted by extension** — only PNG/JPEG/GIF/WEBP signatures are accepted (SVG excluded outright, since it can carry `<script>`), capped at 5MB before decoding, written to a randomized filename under an allowlisted directory, and served back with `X-Content-Type-Options: nosniff`.
- **Link URLs are scheme-validated** (`http:`/`https:`/`mailto:`/relative only) at four independent layers — the editor, on save, on read, and at render — since a `.mdx` file can always be hand-edited outside cimisy entirely.
- **Rate limiting** on writes and the OAuth callback, with a pluggable interface — the shipped in-memory default is explicitly not safe across multiple serverless instances; supply your own `RateLimiter` backed by shared storage in that kind of deployment.
- Secrets (App private key, client secret, session secret) are imported only in modules marked `server-only`, so a client-bundle leak is a build error, not a runtime surprise.

Full write-up, including the specific threat model and what's explicitly out of scope for v1: [SECURITY.md](https://github.com/samreshan/cimisy/blob/main/SECURITY.md) and [THREAT_MODEL.md](https://github.com/samreshan/cimisy/blob/main/THREAT_MODEL.md). Report vulnerabilities via GitHub's private vulnerability reporting — not a public issue.

## Scanning & importing existing content

Bringing an existing site under cimisy is a three-step flow:

```sh
npx cimisy scan --full   # 1. find hardcoded content across the whole site
npx cimisy import        # 2. pick candidates and move them under cimisy's management
npx cimisy setup         # 3. scaffold the admin UI page and API route
```

`cimisy scan` statically analyzes a Next.js App Router codebase for hardcoded content that could move into cimisy, and `cimisy import` interactively applies the candidates you pick — writing content files, inserting config (creating `cimisy.config.ts` if you don't have one yet), and rewriting the source to read through the Reader. Import runs on a dedicated git branch and only supports `localSource` targets. `cimisy setup` then scaffolds whatever the quickstart's manual steps would have had you write by hand — `cimisy.config.*` (when import hasn't already created it), the admin page at `app/(cimisy)/admin/[[...segments]]/page.tsx`, and the API route at `app/api/cimisy/[...route]/route.ts` — never overwriting anything that already exists, so it's safe to re-run. After step 3, start your dev server and open `/admin`.

The scan analyzes every App Router entrypoint — `page.*`, `layout.*`, `template.*`, `not-found.*`, `loading.*`, `error.*`, `global-error.*` (including inside `@slot` parallel-route directories) — plus the components they transitively render. Content found only in layouts is proposed as a shared singleton spanning every route below it.

### Scan modes

```sh
npx cimisy scan --mode=static-metadata
```

| Mode | Repeating arrays → collections | Static headings/paragraphs/images/links → sections/singletons | `export const metadata` → SEO |
|---|---|---|---|
| `collections` (default) | ✓ | | |
| `collections-metadata` | ✓ | | ✓ |
| `static` | ✓ | ✓ | |
| `static-metadata` | ✓ | ✓ | ✓ |

Precedence: `--mode` flag > the config's `scan.mode` > `collections`. (`--full` is shorthand for `--mode=static-metadata`.) Set defaults in `cimisy.config.ts` — both values must be plain literals, since the CLI reads the config statically without executing it:

```ts
export default config({
  // ...
  scan: {
    mode: "static-metadata",
    // appDir-relative path prefixes to skip entirely:
    exclude: ["(cimisy)", "api"],
  },
});
```

### Metadata import

A page's static `export const metadata = { title, description, openGraph: { url } }` is offered as an importable candidate: `cimisy import` inserts a `seo: section({ schema: { seo: fields.seo() } })` under that page in the config, writes the extracted values as YAML, and replaces the statement with a `generateMetadata()` that reads them back through the Reader and `createMetadata()` — so the SEO panel in the admin now controls the page's metadata.

Refused (reported as "not import-eligible", never silently mangled): metadata containing properties `fields.seo()` can't store (`keywords`, `robots`, `openGraph.images`, …), `openGraph.title`/`description` that differ from the top-level values, non-literal values, existing `generateMetadata()` exports (already dynamic), and layout-level metadata (it spans every route below the layout — fold it into your site-wide SEO defaults instead).

### CI mode

```yaml
- run: npx cimisy scan --ci --mode=static-metadata
```

`--ci` prints a one-line summary to stderr and exits **0** when the scan is clean, **1** when any candidate *or unanalyzable detection* exists (unanalyzable items are still hardcoded content the scanner saw — a gate that ignored them would lie), and **2** when the scan itself failed. Use `scan.exclude` or a narrower mode to silence areas that are deliberately out of scope. `--json` prints the full machine-readable report to stdout with project-root-relative paths, suitable as a CI artifact (`npx cimisy scan --ci --json > scan-report.json`).

## Migrating to / away from cimisy

**Into cimisy:** point a collection's `path` at your existing MDX files (adjust their frontmatter to match your `schema`) — there's no transform step because cimisy doesn't use a proprietary storage format to begin with. For content that's hardcoded in your components rather than already in files, use [`cimisy scan` / `cimisy import`](#scanning--importing-existing-content).

**Away from cimisy:** delete the two route files (`app/(cimisy)/admin/...`, `app/api/cimisy/...`) and `cimisy.config.ts`. What's left in your repo is plain MDX files with YAML frontmatter and a normal Next.js app — there is no export step, because content was never stored anywhere other than your own repository in a human-readable format.

## Appendix: registering the App by hand

`npx cimisy setup github` does all of this for you — this is here for the cases it can't cover (no browser on the machine, an existing App you want to reuse, or you'd simply rather see every setting).

1. **Pick a repo.** It needs at least one commit already (an empty repo has no branch/ref for the adapter to read).
2. **Register the App** — GitHub → Settings → Developer settings → GitHub Apps → New GitHub App (use your org's settings instead of your personal ones for an org-owned repo).
   - **Homepage URL**: your app's URL (`http://localhost:3000` for local dev)
   - **Callback URL**: `<your-app-url>/api/cimisy/auth/callback` — add `http://localhost:3000/api/cimisy/auth/callback` as a second one while you're here, so local sign-in works too
   - **Request user authorization (OAuth) during installation**: check it
   - **Webhook**: uncheck "Active" — not required
   - **Repository permissions**: Contents → **Read and write**, Pull requests → **Read and write**, Organization → Members → **Read-only** (Metadata read-only is checked automatically)
   - **Where can this GitHub App be installed?**: "Only on this account"
3. **Collect credentials** from the App's settings page:
   - App ID → `CIMISY_GITHUB_APP_ID`
   - Client ID → `CIMISY_GITHUB_APP_CLIENT_ID`
   - Client secrets → Generate new → `CIMISY_GITHUB_APP_CLIENT_SECRET`
   - Private keys → Generate a private key → paste the downloaded `.pem`'s full contents into `CIMISY_GITHUB_APP_PRIVATE_KEY` (real newlines or literal `\n` both work — cimisy normalizes either form)
4. **Install the App** on your repo from the App's settings page ("Install App" in the sidebar).
5. **Set a session secret**: `CIMISY_SESSION_SECRET`, any long random string (`openssl rand -base64 32`).
6. **Set `CIMISY_SOURCE=github`** and `CIMISY_GITHUB_REPO=owner/repo`, then run `npx cimisy doctor` to confirm all of the above landed correctly.

Once installed, what a signed-in user can do depends on their GitHub **collaborator permission level on that repo** (not just "are they signed in"): Admin/Maintain publish directly, Write drafts via branch + PR, Read/Triage are read-only, and non-collaborators are rejected even with a valid GitHub identity. See [RBAC guide](#rbac-guide) to customize this mapping.

A complete runnable example (including the `.env.local` template) lives at [`examples/next-github`](https://github.com/samreshan/cimisy/tree/main/examples/next-github) in the repo.

## License

Apache-2.0
