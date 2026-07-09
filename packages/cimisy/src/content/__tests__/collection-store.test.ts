import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collection } from "../../config/collection.js";
import { blocks, fields } from "../../config/fields/index.js";
import { LocalStorageAdapter } from "../../storage/local.js";
import { listEntries, writeEntry } from "../collection-store.js";

const AUTHOR = { id: "1", name: "Test", email: "test@example.com" };

const postsDef = collection({
  label: "Posts",
  path: "posts/*.mdx",
  slugField: "slug",
  schema: {
    title: fields.text({ label: "Title" }),
    slug: fields.slug({ source: "title" }),
    body: fields.blocks({ label: "Body", blocks: { paragraph: blocks.paragraph() } }),
  },
});

describe("listEntries — per-file error isolation", () => {
  let rootDir: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "cimisy-collection-store-test-"));
    adapter = new LocalStorageAdapter({ rootDir, allowInProduction: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("a hand-edited malicious/broken file doesn't prevent other entries from listing", async () => {
    await writeEntry(adapter, postsDef, {
      values: { title: "Good Post", body: [{ type: "paragraph", id: "1", props: { text: "fine" } }] },
      baseVersion: null,
      author: AUTHOR,
      message: "create",
      ref: "main",
    });

    // Simulate a hand-edit outside the UI: malicious MDX written directly
    // to disk, never validated by writeEntry/serializeEntry.
    const maliciousContent = [
      "---",
      "title: Malicious",
      "slug: malicious",
      "---",
      "",
      'import Evil from "evil-package"',
      "",
      '{fetch("http://evil.com")}',
      "",
    ].join("\n");
    await writeFile(join(rootDir, "posts/malicious.mdx"), maliciousContent, "utf8");

    const entries = await listEntries(adapter, postsDef);
    expect(entries).toHaveLength(2);

    const good = entries.find((e) => e.slug === "good-post");
    expect(good?.error).toBeUndefined();
    expect(good?.values.title).toBe("Good Post");

    const broken = entries.find((e) => e.slug === "malicious");
    expect(broken?.error).toBeTruthy();
    expect(broken?.values).toEqual({});
  });

  it("a plain syntax/typo error (not just a security rejection) is also isolated the same way", async () => {
    await writeEntry(adapter, postsDef, {
      values: { title: "Valid", body: [] },
      baseVersion: null,
      author: AUTHOR,
      message: "create",
      ref: "main",
    });
    await writeFile(join(rootDir, "posts/no-frontmatter.mdx"), "This file has no frontmatter at all.", "utf8");

    const entries = await listEntries(adapter, postsDef);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.slug === "no-frontmatter")?.error).toBeTruthy();
    expect(entries.find((e) => e.slug === "valid")?.error).toBeUndefined();
  });
});
