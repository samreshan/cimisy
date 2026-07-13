import { describe, expect, it } from "vitest";
import { LocalStorageAdapter } from "../../storage/local.js";
import { collection } from "../collection.js";
import { config } from "../define-config.js";
import { fields } from "../fields/index.js";
import { page } from "../page.js";
import { section } from "../section.js";
import { singleton } from "../singleton.js";

function makeSource() {
  return new LocalStorageAdapter({ rootDir: "/tmp/cimisy-test", allowInProduction: true });
}

const postSchema = {
  title: fields.text({ label: "Title" }),
  slug: fields.slug({ source: "title" }),
};

function makeMixedConfig() {
  return config({
    source: makeSource(),
    collections: {
      posts: collection({ label: "Posts", path: "content/posts/*.mdx", slugField: "slug", schema: postSchema }),
    },
    singletons: {
      settings: singleton({
        label: "Site settings",
        path: "content/settings.yaml",
        schema: { title: fields.text({ label: "Site title" }) },
      }),
    },
    pages: {
      home: page({
        label: "Home",
        route: "/",
        sections: {
          hero: section({
            label: "Hero",
            schema: { heading: fields.text({ label: "Heading" }) },
          }),
          testimonials: collection({ label: "Testimonials", slugField: "slug", schema: postSchema }),
        },
      }),
    },
  });
}

describe("config() normalization", () => {
  it("normalizes a mixed config into flat keys, resolved paths, and a content tree", () => {
    const resolved = makeMixedConfig();

    expect(Object.keys(resolved.collectionsByKey)).toEqual(["posts", "home.testimonials"]);
    expect(resolved.collectionsByKey["posts"]).toMatchObject({
      key: "posts",
      path: "content/posts/*.mdx",
      directory: "content/posts",
      extension: ".mdx",
    });
    expect(resolved.collectionsByKey["home.testimonials"]).toMatchObject({
      key: "home.testimonials",
      path: "content/pages/home/testimonials/*.mdx",
      directory: "content/pages/home/testimonials",
      extension: ".mdx",
    });

    expect(Object.keys(resolved.singletonsByKey)).toEqual(["settings", "home.hero"]);
    expect(resolved.singletonsByKey["settings"]).toMatchObject({
      key: "settings",
      path: "content/settings.yaml",
      format: "yaml",
      previewPath: undefined,
    });
    // Sections inherit the page route as their preview path.
    expect(resolved.singletonsByKey["home.hero"]).toMatchObject({
      key: "home.hero",
      path: "content/pages/home/hero.yaml",
      format: "yaml",
      previewPath: "/",
    });

    expect(resolved.contentTree).toEqual([
      { kind: "collection", key: "posts", label: "Posts" },
      { kind: "singleton", key: "settings", label: "Site settings" },
      {
        kind: "page",
        key: "home",
        label: "Home",
        route: "/",
        children: [
          { kind: "singleton", key: "home.hero", label: "Hero" },
          { kind: "collection", key: "home.testimonials", label: "Testimonials" },
        ],
      },
    ]);
  });

  it("respects an explicit page path when deriving nested paths", () => {
    const resolved = config({
      source: makeSource(),
      pages: {
        about: page({
          label: "About",
          path: "site/about",
          sections: { intro: section({ label: "Intro", schema: { body: fields.text({ label: "Body" }) } }) },
        }),
      },
    });
    expect(resolved.singletonsByKey["about.intro"]!.path).toBe("site/about/intro.yaml");
  });

  it("derives mdx format (and .mdx section paths) when a schema has a body field", () => {
    const resolved = config({
      source: makeSource(),
      pages: {
        home: page({
          label: "Home",
          sections: {
            story: section({
              label: "Story",
              schema: { content: fields.blocks({ blocks: {} }) },
            }),
          },
        }),
      },
    });
    expect(resolved.singletonsByKey["home.story"]).toMatchObject({
      path: "content/pages/home/story.mdx",
      format: "mdx",
    });
  });

  it("keeps a flat v2-style config byte-identical in behavior (same keys, same paths)", () => {
    const resolved = config({
      source: makeSource(),
      collections: {
        posts: collection({ label: "Posts", path: "content/posts/*.mdx", slugField: "slug", schema: postSchema }),
      },
    });
    expect(resolved.collectionsByKey["posts"]!.path).toBe("content/posts/*.mdx");
    expect(resolved.singletonsByKey).toEqual({});
    expect(resolved.contentTree).toEqual([{ kind: "collection", key: "posts", label: "Posts" }]);
  });

  describe("fail-closed validation", () => {
    it("rejects duplicate keys across collections and singletons", () => {
      expect(() =>
        config({
          source: makeSource(),
          collections: {
            settings: collection({ label: "X", path: "content/x/*.mdx", slugField: "slug", schema: postSchema }),
          },
          singletons: {
            settings: singleton({ label: "Settings", path: "content/settings.yaml", schema: {} }),
          },
        }),
      ).toThrow(/declared twice/);
    });

    it("rejects a page key colliding with a collection key", () => {
      expect(() =>
        config({
          source: makeSource(),
          collections: {
            home: collection({ label: "Home", path: "content/home/*.mdx", slugField: "slug", schema: postSchema }),
          },
          pages: {
            home: page({ label: "Home", sections: { hero: section({ label: "Hero", schema: {} }) } }),
          },
        }),
      ).toThrow(/declared twice/);
    });

    it("rejects duplicate resolved paths", () => {
      expect(() =>
        config({
          source: makeSource(),
          collections: {
            a: collection({ label: "A", path: "content/x/*.mdx", slugField: "slug", schema: postSchema }),
            b: collection({ label: "B", path: "content/x/*.mdx", slugField: "slug", schema: postSchema }),
          },
        }),
      ).toThrow(/both use path/);
    });

    it.each(["team", "drafts", "pages", "new"])("rejects the reserved top-level key %j", (key) => {
      expect(() =>
        config({
          source: makeSource(),
          singletons: { [key]: singleton({ label: "X", path: `content/${key}.yaml`, schema: {} }) },
        }),
      ).toThrow(/reserved/);
    });

    it.each(["UpperCase", "with_underscore", "with space", "double--hyphen", "-lead", ""])(
      "rejects the invalid key %j",
      (key) => {
        expect(() =>
          config({
            source: makeSource(),
            singletons: { [key]: singleton({ label: "X", path: "content/x.yaml", schema: {} }) },
          }),
        ).toThrow(/not valid|is not valid/);
      },
    );

    it("rejects a section key of 'lock' (would create a .lock-suffixed draft branch component)", () => {
      expect(() =>
        config({
          source: makeSource(),
          pages: {
            home: page({ label: "Home", sections: { lock: section({ label: "Lock", schema: {} }) } }),
          },
        }),
      ).toThrow(/\.lock/);
    });

    it("rejects yaml format combined with a body field", () => {
      expect(() =>
        config({
          source: makeSource(),
          singletons: {
            story: singleton({
              label: "Story",
              path: "content/story.yaml",
              format: "yaml",
              schema: { content: fields.blocks({ blocks: {} }) },
            }),
          },
        }),
      ).toThrow(/cannot store body fields/);
    });

    it("rejects a singleton path whose extension contradicts its format", () => {
      expect(() =>
        config({
          source: makeSource(),
          singletons: {
            settings: singleton({ label: "Settings", path: "content/settings.mdx", schema: {} }),
          },
        }),
      ).toThrow(/doesn't match its yaml format/);
    });

    it("rejects a top-level collection without a path", () => {
      expect(() =>
        config({
          source: makeSource(),
          collections: {
            posts: collection({ label: "Posts", slugField: "slug", schema: postSchema }),
          },
        }),
      ).toThrow(/must declare a path/);
    });

    it.each(["../escape", "/absolute", "trailing/", "with space"])(
      "rejects the unsafe page path %j",
      (path) => {
        expect(() =>
          config({
            source: makeSource(),
            pages: {
              home: page({ label: "Home", path, sections: { hero: section({ label: "Hero", schema: {} }) } }),
            },
          }),
        ).toThrow(/not valid/);
      },
    );
  });
});
