import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collection } from "../../config/collection.js";
import { config } from "../../config/define-config.js";
import { fields } from "../../config/fields/index.js";
import { singleton } from "../../config/singleton.js";
import { ValidationError } from "../../shared/errors.js";
import { LocalStorageAdapter } from "../../storage/local.js";
import { readEntry, writeEntry } from "../collection-store.js";
import { readSingleton, writeSingleton } from "../singleton-store.js";
import { validateFieldValues } from "../validate-values.js";

const AUTHOR = { id: "1", name: "Test", email: "test@example.com" };

const testConfig = config({
  source: new LocalStorageAdapter({ rootDir: "/tmp/unused", allowInProduction: true }),
  collections: {
    posts: collection({
      label: "Posts",
      path: "posts/*.mdx",
      slugField: "slug",
      schema: {
        title: fields.text({ label: "Title", validation: { isRequired: true, maxLength: 10 } }),
        slug: fields.slug({ source: "title" }),
        subtitle: fields.text({ label: "Subtitle" }),
        tags: fields.array(fields.text({ label: "Tag" })),
      },
    }),
  },
  singletons: {
    settings: singleton({
      label: "Settings",
      path: "settings.yaml",
      schema: {
        siteName: fields.text({ label: "Site name", validation: { isRequired: true } }),
      },
    }),
  },
});
const postsDef = testConfig.collectionsByKey["posts"]!;
const settingsDef = testConfig.singletonsByKey["settings"]!;

interface IssueLike {
  path: (string | number)[];
  message: string;
}

function issuesOf(err: unknown): IssueLike[] {
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).issues as IssueLike[];
}

describe("validateFieldValues", () => {
  it("prefixes issue paths with the field name and collects all failing fields", () => {
    let caught: unknown;
    try {
      validateFieldValues(postsDef.schema, { title: "", slug: "x", tags: [42] });
    } catch (err) {
      caught = err;
    }
    const issues = issuesOf(caught);
    expect(issues.some((i) => i.path[0] === "title" && i.message === "Required.")).toBe(true);
    expect(issues.some((i) => i.path[0] === "tags" && i.path[1] === 0)).toBe(true);
  });

  it("reports a friendly maxLength message", () => {
    let caught: unknown;
    try {
      validateFieldValues(postsDef.schema, { title: "way too long for ten", slug: "x" });
    } catch (err) {
      caught = err;
    }
    expect(issuesOf(caught).some((i) => i.path[0] === "title" && i.message === "Must be 10 characters or fewer.")).toBe(
      true,
    );
  });

  it("normalizes untouched optional fields to their defaults", () => {
    const normalized = validateFieldValues(postsDef.schema, { title: "Hello", slug: "hello" });
    expect(normalized.subtitle).toBe("");
    expect(normalized.tags).toEqual([]);
  });
});

describe("write-path validation (the invalid-save-then-unreadable-entry hole)", () => {
  let rootDir: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "cimisy-validate-values-test-"));
    adapter = new LocalStorageAdapter({ rootDir, allowInProduction: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("writeEntry rejects an invalid save instead of writing an unreadable file", async () => {
    await expect(
      writeEntry(adapter, postsDef, {
        values: { title: "way too long for ten" },
        baseVersion: null,
        author: AUTHOR,
        message: "create",
        ref: "main",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await adapter.list("posts")).toEqual([]);
  });

  it("an entry saved with untouched optional fields can be read back", async () => {
    const { slug } = await writeEntry(adapter, postsDef, {
      values: { title: "Hello" },
      baseVersion: null,
      author: AUTHOR,
      message: "create",
      ref: "main",
    });
    const entry = await readEntry(adapter, postsDef, slug);
    expect(entry?.values.title).toBe("Hello");
    expect(entry?.values.subtitle).toBe("");
    expect(entry?.values.tags).toEqual([]);
  });

  it("writeSingleton rejects an invalid save with field-prefixed issues", async () => {
    let caught: unknown;
    try {
      await writeSingleton(adapter, settingsDef, {
        values: { siteName: "" },
        baseVersion: null,
        author: AUTHOR,
        message: "save",
        ref: "main",
      });
    } catch (err) {
      caught = err;
    }
    expect(issuesOf(caught).some((i) => i.path[0] === "siteName" && i.message === "Required.")).toBe(true);
    expect(await readSingleton(adapter, settingsDef)).toBeNull();
  });
});
