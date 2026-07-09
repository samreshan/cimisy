import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnsafePathError } from "../../shared/errors.js";
import { LocalStorageAdapter } from "../local.js";

describe("LocalStorageAdapter", () => {
  let rootDir: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "cimisy-test-"));
    adapter = new LocalStorageAdapter({ rootDir, allowInProduction: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("refuses to construct under NODE_ENV=production without allowInProduction", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => new LocalStorageAdapter({ rootDir })).toThrow();
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("writes and reads a file back", async () => {
    const result = await adapter.commitChange({
      ref: "main",
      baseVersion: null,
      message: "create",
      author: { id: "1", name: "T", email: "t@example.com" },
      writes: [{ path: "posts/a.mdx", content: "hello" }],
    });
    expect(result.conflict).toBeUndefined();
    const record = await adapter.read("posts/a.mdx");
    expect(record?.content).toBe("hello");
  });

  it("rejects path-traversal reads even though the path was pre-validated upstream", async () => {
    await expect(adapter.read("../../etc/passwd")).rejects.toThrow(UnsafePathError);
    await expect(adapter.read("posts/../../secret")).rejects.toThrow(UnsafePathError);
  });

  it("rejects path-traversal writes", async () => {
    await expect(
      adapter.commitChange({
        ref: "main",
        baseVersion: null,
        message: "evil",
        author: { id: "1", name: "T", email: "t@example.com" },
        writes: [{ path: "../../etc/passwd", content: "pwned" }],
      }),
    ).rejects.toThrow(UnsafePathError);
  });

  it("detects a write conflict when baseVersion is stale", async () => {
    const first = await adapter.commitChange({
      ref: "main",
      baseVersion: null,
      message: "create",
      author: { id: "1", name: "T", email: "t@example.com" },
      writes: [{ path: "posts/a.mdx", content: "v1" }],
    });
    expect(first.conflict).toBeUndefined();

    const conflicting = await adapter.commitChange({
      ref: "main",
      baseVersion: null, // stale — caller still thinks the file doesn't exist
      message: "create again",
      author: { id: "1", name: "T", email: "t@example.com" },
      writes: [{ path: "posts/a.mdx", content: "v2" }],
    });
    expect(conflicting.conflict).toBeDefined();

    const record = await adapter.read("posts/a.mdx");
    expect(record?.content).toBe("v1"); // rejected write must not have landed
  });

  it("detects a delete conflict when baseVersion is stale", async () => {
    await adapter.commitChange({
      ref: "main",
      baseVersion: null,
      message: "create",
      author: { id: "1", name: "T", email: "t@example.com" },
      writes: [{ path: "posts/a.mdx", content: "v1" }],
    });

    const conflicting = await adapter.commitChange({
      ref: "main",
      baseVersion: null, // stale — real version is non-null
      message: "delete",
      author: { id: "1", name: "T", email: "t@example.com" },
      writes: [],
      deletes: ["posts/a.mdx"],
    });
    expect(conflicting.conflict).toBeDefined();
    const record = await adapter.read("posts/a.mdx");
    expect(record).not.toBeNull(); // rejected delete must not have landed
  });

  it("allows a delete when baseVersion matches", async () => {
    const created = await adapter.commitChange({
      ref: "main",
      baseVersion: null,
      message: "create",
      author: { id: "1", name: "T", email: "t@example.com" },
      writes: [{ path: "posts/a.mdx", content: "v1" }],
    });

    const deleted = await adapter.commitChange({
      ref: "main",
      baseVersion: created.version,
      message: "delete",
      author: { id: "1", name: "T", email: "t@example.com" },
      writes: [],
      deletes: ["posts/a.mdx"],
    });
    expect(deleted.conflict).toBeUndefined();
    expect(await adapter.read("posts/a.mdx")).toBeNull();
  });

  it("lists files under a directory", async () => {
    await adapter.commitChange({
      ref: "main",
      baseVersion: null,
      message: "create",
      author: { id: "1", name: "T", email: "t@example.com" },
      writes: [
        { path: "posts/a.mdx", content: "a" },
        { path: "posts/b.mdx", content: "b" },
      ],
    });
    const files = await adapter.list("posts");
    expect(files.map((f) => f.path).sort()).toEqual(["posts/a.mdx", "posts/b.mdx"]);
  });

  it("returns an empty list for a directory that doesn't exist yet", async () => {
    expect(await adapter.list("nonexistent")).toEqual([]);
  });
});
