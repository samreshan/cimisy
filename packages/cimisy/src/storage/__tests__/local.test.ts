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

  it("commits a base64-encoded binary file and reads its raw bytes back unchanged", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    const base64 = pngBytes.toString("base64");
    const result = await adapter.commitChange({
      ref: "main",
      baseVersion: null,
      message: "upload image",
      author: { id: "1", name: "T", email: "t@example.com" },
      writes: [{ path: "images/a.png", content: base64, encoding: "base64" }],
    });
    expect(result.conflict).toBeUndefined();

    const raw = await adapter.readRaw("images/a.png");
    expect(raw).not.toBeNull();
    expect(Buffer.from(raw!.content).equals(pngBytes)).toBe(true);
  });

  it("readRaw returns null for a file that doesn't exist", async () => {
    expect(await adapter.readRaw("images/missing.png")).toBeNull();
  });

  it("readRaw rejects path-traversal reads", async () => {
    await expect(adapter.readRaw("../../etc/passwd")).rejects.toThrow(UnsafePathError);
  });

  it("optimistic concurrency works the same for binary writes as for text writes (version computed from raw bytes)", async () => {
    const first = await adapter.commitChange({
      ref: "main",
      baseVersion: null,
      message: "upload",
      author: { id: "1", name: "T", email: "t@example.com" },
      writes: [{ path: "images/a.png", content: Buffer.from([1, 2, 3]).toString("base64"), encoding: "base64" }],
    });
    const conflicting = await adapter.commitChange({
      ref: "main",
      baseVersion: null, // stale
      message: "overwrite",
      author: { id: "1", name: "T", email: "t@example.com" },
      writes: [{ path: "images/a.png", content: Buffer.from([4, 5, 6]).toString("base64"), encoding: "base64" }],
    });
    expect(conflicting.conflict).toBeDefined();

    const stillOriginal = await adapter.readRaw("images/a.png");
    expect(Buffer.from(stillOriginal!.content).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(first.version).toBeTruthy();
  });
});
