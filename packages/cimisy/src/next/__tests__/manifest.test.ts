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

    expect(manifest.tree.map((n) => ({ kind: n.kind, key: n.key }))).toEqual([
      { kind: "collection", key: "posts" },
      { kind: "singleton", key: "settings" },
      { kind: "page", key: "home" },
    ]);
    const pageNode = manifest.tree.find((n) => n.kind === "page");
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
  });
});
