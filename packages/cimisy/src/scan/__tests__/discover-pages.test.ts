import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPages } from "../discover-pages.js";

describe("discoverPages", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-discover-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function touch(relPath: string): Promise<void> {
    const full = path.join(root, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "");
  }

  it("finds page.tsx at the app root and in nested route segments", async () => {
    await touch("page.tsx");
    await touch("news/page.tsx");
    await touch("news/[slug]/page.tsx");
    await touch("(marketing)/about/page.tsx");

    const pages = await discoverPages({ appDir: root });

    expect(pages.sort()).toEqual(
      [
        path.join(root, "(marketing)/about/page.tsx"),
        path.join(root, "news/[slug]/page.tsx"),
        path.join(root, "news/page.tsx"),
        path.join(root, "page.tsx"),
      ].sort(),
    );
  });

  it("ignores non-page.tsx files (layout.tsx, components, css)", async () => {
    await touch("layout.tsx");
    await touch("globals.css");
    await touch("components/HomeHero.tsx");
    await touch("page.tsx");

    const pages = await discoverPages({ appDir: root });

    expect(pages).toEqual([path.join(root, "page.tsx")]);
  });

  it("finds page.js/.jsx/.ts pages too (regression: a plain-JS App Router project used to match nothing)", async () => {
    await touch("page.js");
    await touch("news/page.jsx");
    await touch("about/page.ts");
    await touch("layout.js");

    const pages = await discoverPages({ appDir: root });

    expect(pages.sort()).toEqual(
      [path.join(root, "about/page.ts"), path.join(root, "news/page.jsx"), path.join(root, "page.js")].sort(),
    );
  });

  it("skips node_modules, .next, .git, and dotfile directories", async () => {
    await touch("node_modules/some-pkg/page.tsx");
    await touch(".next/cache/page.tsx");
    await touch(".git/hooks/page.tsx");
    await touch(".hidden/page.tsx");
    await touch("page.tsx");

    const pages = await discoverPages({ appDir: root });

    expect(pages).toEqual([path.join(root, "page.tsx")]);
  });

  it("returns an empty array when appDir doesn't exist", async () => {
    const pages = await discoverPages({ appDir: path.join(root, "does-not-exist") });
    expect(pages).toEqual([]);
  });
});

// discoverEntrypoints is the 2.3 superset API discoverPages wraps.
import { discoverEntrypoints } from "../discover-pages.js";

describe("discoverEntrypoints", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-discover-ep-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function touch(relPath: string): Promise<void> {
    const full = path.join(root, relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "");
  }

  it("finds layout/template/not-found/loading/error/global-error alongside pages", async () => {
    await touch("page.tsx");
    await touch("layout.tsx");
    await touch("template.tsx");
    await touch("not-found.tsx");
    await touch("loading.tsx");
    await touch("error.tsx");
    await touch("global-error.tsx");
    await touch("route.ts"); // handler — never an entrypoint
    await touch("default.tsx"); // parallel-route fallback — deferred

    const entrypoints = await discoverEntrypoints({ appDir: root });
    expect(entrypoints.map((e) => e.kind).sort()).toEqual(
      ["error", "global-error", "layout", "loading", "not-found", "page", "template"].sort(),
    );
  });

  it("walks @slot parallel-route dirs but skips (.)-style intercepting-route dirs", async () => {
    await touch("@sidebar/page.tsx");
    await touch("feed/(..)photo/page.tsx");
    await touch("feed/(.)modal/page.tsx");
    await touch("feed/page.tsx");

    const entrypoints = await discoverEntrypoints({ appDir: root });
    expect(entrypoints.map((e) => path.relative(root, e.filePath)).sort()).toEqual(
      ["@sidebar/page.tsx", "feed/page.tsx"].sort(),
    );
  });

  it("applies exclude prefixes (appDir-relative, matching whole segments)", async () => {
    await touch("admin/page.tsx");
    await touch("admin/settings/page.tsx");
    await touch("administrivia/page.tsx"); // prefix of the *string* but not the path — kept
    await touch("page.tsx");

    const entrypoints = await discoverEntrypoints({ appDir: root, exclude: ["admin"] });
    expect(entrypoints.map((e) => path.relative(root, e.filePath)).sort()).toEqual(
      ["administrivia/page.tsx", "page.tsx"].sort(),
    );
  });
});
