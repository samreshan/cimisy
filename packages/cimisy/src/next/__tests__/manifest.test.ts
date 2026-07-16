import { describe, expect, it } from "vitest";
import { collection, config, fields, page, section, singleton } from "../../config/index.js";
import { LocalStorageAdapter } from "../../storage/local.js";
import { buildAdminManifest } from "../manifest.js";

function buildMixedConfig() {
  return config({
    source: new LocalStorageAdapter({ rootDir: "/tmp/cimisy-manifest-test", allowInProduction: true }),
    collections: {
      posts: collection({
        label: "Posts",
        path: "content/posts/*.mdx",
        slugField: "slug",
        previewPath: "/blog/:slug",
        schema: {
          title: fields.text({ label: "Title" }),
          slug: fields.slug({ source: "title" }),
          seo: fields.seo({ imageDirectory: "content/uploads" }),
        },
      }),
    },
    singletons: {
      settings: singleton({
        label: "Site settings",
        path: "content/settings.yaml",
        schema: { siteName: fields.text({ label: "Site name" }) },
      }),
    },
    pages: {
      home: page({
        label: "Home",
        route: "/",
        sections: {
          hero: section({ label: "Hero", schema: { heading: fields.text({ label: "Heading" }) } }),
          testimonials: collection({
            label: "Testimonials",
            slugField: "slug",
            schema: { quote: fields.text({ label: "Quote" }), slug: fields.slug({ source: "quote" }) },
          }),
        },
      }),
    },
  });
}

describe("buildAdminManifest — hierarchy projection", () => {
  it("projects the content tree with a flat byKey lookup covering every entity", () => {
    const manifest = buildAdminManifest(buildMixedConfig());

    // "posts" has previewPath "/blog/:slug" and no declared page() for "/blog",
    // so it's pulled into a synthetic "__route:/blog" group — see the
    // "route grouping" describe block below for dedicated coverage.
    expect(manifest.tree.map((n) => ({ kind: n.kind, key: n.key }))).toEqual([
      { kind: "page", key: "__route:/blog" },
      { kind: "singleton", key: "settings" },
      { kind: "page", key: "home" },
    ]);
    const blogGroup = manifest.tree.find((n) => n.key === "__route:/blog");
    expect(blogGroup && "children" in blogGroup ? blogGroup.children.map((c) => c.key) : []).toEqual(["posts"]);
    const pageNode = manifest.tree.find((n) => n.key === "home");
    expect(pageNode && "children" in pageNode ? pageNode.children.map((c) => c.key) : []).toEqual([
      "home.hero",
      "home.testimonials",
    ]);
    expect(Object.keys(manifest.byKey).sort()).toEqual(["home.hero", "home.testimonials", "posts", "settings"]);
  });

  it("sections inherit the page route as their previewPath; a routeless singleton gets none", () => {
    const manifest = buildAdminManifest(buildMixedConfig());
    expect(manifest.byKey["home.hero"]?.previewPath).toBe("/");
    expect(manifest.byKey["settings"]?.previewPath).toBeUndefined();
    expect(manifest.byKey["posts"]?.previewPath).toBe("/blog/:slug");
  });

  it("exposes a seo field's imageDirectory through the standard `directory` channel", () => {
    const manifest = buildAdminManifest(buildMixedConfig());
    const seoField = manifest.byKey["posts"]?.fields.find((f) => f.kind === "seo");
    expect(seoField?.directory).toBe("content/uploads");
  });

  it("is JSON-serializable — no zod schemas, adapters, or functions leak to the client", () => {
    const manifest = buildAdminManifest(buildMixedConfig());
    const roundTripped: unknown = JSON.parse(JSON.stringify(manifest));
    expect(roundTripped).toEqual(manifest);
    // buildMixedConfig's "posts" previewPath triggers a synthetic route
    // group (see "route grouping" below) — confirms that shape round-trips too.
    expect(manifest.tree.some((n) => n.key === "__route:/blog")).toBe(true);
  });
});

function localSourceForTest() {
  return new LocalStorageAdapter({ rootDir: "/tmp/cimisy-manifest-test", allowInProduction: true });
}

describe("buildAdminManifest — route grouping", () => {
  it("groups a top-level collection with a previewPath into a synthetic route group", () => {
    const manifest = buildAdminManifest(
      config({
        source: localSourceForTest(),
        collections: {
          posts: collection({
            label: "Posts",
            path: "content/posts/*.mdx",
            slugField: "slug",
            previewPath: "/blog/:slug",
            schema: { title: fields.text({ label: "Title" }), slug: fields.slug({ source: "title" }) },
          }),
        },
      }),
    );

    expect(manifest.tree).toEqual([
      { kind: "page", key: "__route:/blog", label: "Blog", route: "/blog", children: [manifest.byKey["posts"]] },
    ]);
  });

  it("groups a top-level singleton with a previewPath into a synthetic route group", () => {
    const manifest = buildAdminManifest(
      config({
        source: localSourceForTest(),
        singletons: {
          about: singleton({
            label: "About",
            path: "content/about.yaml",
            previewPath: "/about",
            schema: { body: fields.text({ label: "Body" }) },
          }),
        },
      }),
    );

    expect(manifest.tree).toEqual([
      { kind: "page", key: "__route:/about", label: "About", route: "/about", children: [manifest.byKey["about"]] },
    ]);
  });

  it("merges multiple top-level items that share one derived route into a single group", () => {
    const manifest = buildAdminManifest(
      config({
        source: localSourceForTest(),
        collections: {
          posts: collection({
            label: "Posts",
            path: "content/posts/*.mdx",
            slugField: "slug",
            previewPath: "/blog/:slug",
            schema: { title: fields.text({ label: "Title" }), slug: fields.slug({ source: "title" }) },
          }),
        },
        singletons: {
          "blog-settings": singleton({
            label: "Blog settings",
            path: "content/blog-settings.yaml",
            previewPath: "/blog",
            schema: { tagline: fields.text({ label: "Tagline" }) },
          }),
        },
      }),
    );

    expect(manifest.tree).toHaveLength(1);
    const group = manifest.tree[0]!;
    expect(group.kind).toBe("page");
    expect("route" in group ? group.route : undefined).toBe("/blog");
    expect("children" in group ? group.children.map((c) => c.key) : []).toEqual(["posts", "blog-settings"]);
  });

  it("merges a top-level item into a declared page() group sharing its route, instead of duplicating", () => {
    const manifest = buildAdminManifest(
      config({
        source: localSourceForTest(),
        collections: {
          posts: collection({
            label: "Posts",
            path: "content/posts/*.mdx",
            slugField: "slug",
            previewPath: "/blog/:slug",
            schema: { title: fields.text({ label: "Title" }), slug: fields.slug({ source: "title" }) },
          }),
        },
        pages: {
          blog: page({
            label: "Blog index",
            route: "/blog",
            sections: {
              intro: section({ label: "Intro", schema: { text: fields.text({ label: "Text" }) } }),
            },
          }),
        },
      }),
    );

    expect(manifest.tree.map((n) => n.key)).toEqual(["blog"]);
    const pageNode = manifest.tree.find((n) => n.key === "blog")!;
    expect("children" in pageNode ? pageNode.children.map((c) => c.key) : []).toEqual(["blog.intro", "posts"]);
    expect("label" in pageNode ? pageNode.label : undefined).toBe("Blog index");
  });

  it("treats a collection previewPath with no :slug as an already-resolved route", () => {
    const manifest = buildAdminManifest(
      config({
        source: localSourceForTest(),
        collections: {
          archive: collection({
            label: "Archive",
            path: "content/archive/*.mdx",
            slugField: "slug",
            previewPath: "/archive",
            schema: { title: fields.text({ label: "Title" }), slug: fields.slug({ source: "title" }) },
          }),
        },
      }),
    );

    expect(manifest.tree).toEqual([
      { kind: "page", key: "__route:/archive", label: "Archive", route: "/archive", children: [manifest.byKey["archive"]] },
    ]);
  });

  it("leaves a top-level entity with no previewPath as a flat, ungrouped node", () => {
    const manifest = buildAdminManifest(
      config({
        source: localSourceForTest(),
        singletons: {
          settings: singleton({
            label: "Site settings",
            path: "content/settings.yaml",
            schema: { siteName: fields.text({ label: "Site name" }) },
          }),
        },
      }),
    );

    expect(manifest.tree).toEqual([manifest.byKey["settings"]]);
  });

  it("leaves a declared page()'s nested section children untouched when nothing else shares its route", () => {
    const manifest = buildAdminManifest(buildMixedConfig());
    const homeNode = manifest.tree.find((n) => n.key === "home")!;
    expect("children" in homeNode ? homeNode.children.map((c) => c.key) : []).toEqual(["home.hero", "home.testimonials"]);
  });

  it("gives multiple synthetic groups distinct, collision-safe keys", () => {
    const manifest = buildAdminManifest(
      config({
        source: localSourceForTest(),
        collections: {
          posts: collection({
            label: "Posts",
            path: "content/posts/*.mdx",
            slugField: "slug",
            previewPath: "/blog/:slug",
            schema: { title: fields.text({ label: "Title" }), slug: fields.slug({ source: "title" }) },
          }),
          docs: collection({
            label: "Docs",
            path: "content/docs/*.mdx",
            slugField: "slug",
            previewPath: "/docs/:slug",
            schema: { title: fields.text({ label: "Title" }), slug: fields.slug({ source: "title" }) },
          }),
        },
      }),
    );

    const keys = manifest.tree.map((n) => n.key);
    expect(keys).toEqual(["__route:/blog", "__route:/docs"]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(manifest.byKey)).not.toContain("__route:/blog");
  });
});

describe("buildAdminManifest — text validation projection", () => {
  it("copies isRequired/maxLength through to the field manifest, omitting them when absent", () => {
    const cfg = config({
      source: new LocalStorageAdapter({ rootDir: "/tmp/cimisy-manifest-test", allowInProduction: true }),
      collections: {
        posts: collection({
          label: "Posts",
          path: "content/posts/*.mdx",
          slugField: "slug",
          schema: {
            title: fields.text({ label: "Title", validation: { isRequired: true, maxLength: 80 } }),
            subtitle: fields.text({ label: "Subtitle" }),
            slug: fields.slug({ source: "title" }),
          },
        }),
      },
    });
    const manifest = buildAdminManifest(cfg);
    const posts = manifest.byKey["posts"]!;
    const title = posts.fields.find((f) => f.name === "title")!;
    expect(title.required).toBe(true);
    expect(title.maxLength).toBe(80);
    const subtitle = posts.fields.find((f) => f.name === "subtitle")!;
    expect(subtitle.required).toBeUndefined();
    expect(subtitle.maxLength).toBeUndefined();
  });
});
