import { blocks, collection, config, fields } from "cimisy/config";
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

  collections: {
    posts: collection({
      label: "Blog posts",
      path: "content/posts/*.mdx",
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

  // No `roles`/`roleMapping` specified — this app runs on cimisy's default
  // RBAC (see packages/cimisy/src/config/define-config.ts): the first
  // person to sign in bootstraps as admin, and everyone after that starts
  // pending until an admin grants them a role from the Team screen
  // (/admin/team). `roleMapping` below only controls that one-time
  // bootstrap check, not ongoing access. To customize (e.g. restrict a
  // role to specific paths), add:
  //
  // roles: {
  //   admin:     { directPublish: true,  rules: [{ path: "**", actions: ["read", "write", "publish", "manageSchema", "manageUsers"] }] },
  //   publisher: { directPublish: true,  rules: [{ path: "**", actions: ["read", "write", "publish"] }] },
  //   editor:    { directPublish: false, rules: [{ path: "content/posts/**", actions: ["read", "write"] }] },
  //   viewer:    { directPublish: false, rules: [{ path: "**", actions: ["read"] }] },
  // },
  // roleMapping: { admin: "admin", maintain: "admin", write: "editor", triage: "viewer", read: "viewer" },
});
