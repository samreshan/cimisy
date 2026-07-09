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
