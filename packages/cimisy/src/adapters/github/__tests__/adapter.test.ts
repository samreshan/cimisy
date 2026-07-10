import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnsafePathError } from "../../../shared/errors.js";
import { GithubStorageAdapter } from "../adapter.js";
import { createFakeGithubApi, type FakeGithubApi } from "./fake-github-api.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

function makeAdapter(fake: FakeGithubApi): GithubStorageAdapter {
  return new GithubStorageAdapter({
    repo: `${fake.owner}/${fake.repo}`,
    branch: "main",
    appId: "12345",
    privateKey,
    clientId: "client-id",
    clientSecret: "client-secret",
    sessionSecret: "session-secret",
  });
}

const AUTHOR = { id: "1", name: "Test User", email: "test@example.com" };

describe("GithubStorageAdapter", () => {
  let fake: FakeGithubApi;
  let adapter: GithubStorageAdapter;

  beforeEach(() => {
    fake = createFakeGithubApi({
      owner: "acme",
      repo: "site",
      initialFiles: { "posts/existing.mdx": "---\ntitle: Existing\n---\n\nHello." },
    });
    fake.install();
    adapter = makeAdapter(fake);
  });

  afterEach(() => {
    fake.restore();
  });

  it("reads an existing file with its content and version", async () => {
    const record = await adapter.read("posts/existing.mdx");
    expect(record?.content).toBe("---\ntitle: Existing\n---\n\nHello.");
    expect(record?.version).toBeTruthy();
  });

  it("returns null for a file that doesn't exist", async () => {
    expect(await adapter.read("posts/missing.mdx")).toBeNull();
  });

  it("lists files under a directory", async () => {
    const files = await adapter.list("posts");
    expect(files.map((f) => f.path)).toEqual(["posts/existing.mdx"]);
  });

  it("returns an empty list for a directory that doesn't exist", async () => {
    expect(await adapter.list("nonexistent")).toEqual([]);
  });

  it("rejects unsafe paths before making any request", async () => {
    await expect(adapter.read("../../etc/passwd")).rejects.toThrow(UnsafePathError);
    const requestCountBefore = fake.requests.length;
    await expect(adapter.read("../../etc/passwd")).rejects.toThrow();
    expect(fake.requests.length).toBe(requestCountBefore); // no network call was made
  });

  it("commits a new file and makes it readable afterward", async () => {
    const result = await adapter.commitChange({
      ref: "main",
      baseVersion: null,
      message: "create post",
      author: AUTHOR,
      writes: [{ path: "posts/new.mdx", content: "---\ntitle: New\n---\n\nBody." }],
    });
    expect(result.conflict).toBeUndefined();
    expect(result.version).toBeTruthy();

    const record = await adapter.read("posts/new.mdx");
    expect(record?.content).toBe("---\ntitle: New\n---\n\nBody.");
    expect(record?.version).toBe(result.version);
  });

  it("preserves unrelated existing files after a commit (real tree merge, not overwrite)", async () => {
    await adapter.commitChange({
      ref: "main",
      baseVersion: null,
      message: "create post",
      author: AUTHOR,
      writes: [{ path: "posts/new.mdx", content: "new content" }],
    });
    const stillThere = await adapter.read("posts/existing.mdx");
    expect(stillThere?.content).toBe("---\ntitle: Existing\n---\n\nHello.");
  });

  it("detects a conflict when baseVersion is stale", async () => {
    const conflicting = await adapter.commitChange({
      ref: "main",
      baseVersion: "some-other-sha",
      message: "update",
      author: AUTHOR,
      writes: [{ path: "posts/existing.mdx", content: "changed" }],
    });
    expect(conflicting.conflict).toBeDefined();
    const stillOriginal = await adapter.read("posts/existing.mdx");
    expect(stillOriginal?.content).toBe("---\ntitle: Existing\n---\n\nHello.");
  });

  it("updates a file when baseVersion matches", async () => {
    const current = await adapter.read("posts/existing.mdx");
    const result = await adapter.commitChange({
      ref: "main",
      baseVersion: current!.version,
      message: "update",
      author: AUTHOR,
      writes: [{ path: "posts/existing.mdx", content: "updated content" }],
    });
    expect(result.conflict).toBeUndefined();
    const updated = await adapter.read("posts/existing.mdx");
    expect(updated?.content).toBe("updated content");
  });

  it("deletes a file when baseVersion matches", async () => {
    const current = await adapter.read("posts/existing.mdx");
    const result = await adapter.commitChange({
      ref: "main",
      baseVersion: current!.version,
      message: "delete",
      author: AUTHOR,
      writes: [],
      deletes: ["posts/existing.mdx"],
    });
    expect(result.conflict).toBeUndefined();
    expect(await adapter.read("posts/existing.mdx")).toBeNull();
  });

  it("rejects unsafe paths in commitChange writes and deletes", async () => {
    await expect(
      adapter.commitChange({
        ref: "main",
        baseVersion: null,
        message: "evil",
        author: AUTHOR,
        writes: [{ path: "../../etc/passwd", content: "pwned" }],
      }),
    ).rejects.toThrow(UnsafePathError);
  });

  it("looks up a collaborator's repo permission level", async () => {
    fake.setCollaboratorPermission("alice", "write");
    expect(await adapter.getCollaboratorPermission("alice")).toBe("write");
    expect(await adapter.getCollaboratorPermission("bob")).toBeNull();
  });

  it("creates a branch from the current ref", async () => {
    await adapter.createBranch("draft-1", "main");
    const createRefCall = fake.requests.find((r) => r.method === "POST" && r.url.endsWith("/git/refs"));
    expect(createRefCall).toBeDefined();
    expect(fake.filesOnBranch("draft-1").get("posts/existing.mdx")).toBe("---\ntitle: Existing\n---\n\nHello.");
  });

  it("creating a branch that already exists is a no-op, not an error", async () => {
    await adapter.createBranch("draft-1", "main");
    await expect(adapter.createBranch("draft-1", "main")).resolves.not.toThrow();
  });

  it("a commit to a draft branch does not affect the default branch", async () => {
    await adapter.createBranch("draft-1", "main");
    await adapter.commitChange({
      ref: "draft-1",
      baseVersion: (await adapter.read("posts/existing.mdx"))!.version,
      message: "draft edit",
      author: AUTHOR,
      writes: [{ path: "posts/existing.mdx", content: "draft content" }],
    });
    expect(fake.filesOnBranch("draft-1").get("posts/existing.mdx")).toBe("draft content");
    expect(fake.filesOnBranch("main").get("posts/existing.mdx")).toBe("---\ntitle: Existing\n---\n\nHello.");
  });

  it("opens and merges a change request (pull request)", async () => {
    await adapter.createBranch("draft-1", "main");
    const opened = await adapter.openChangeRequest({ sourceRef: "draft-1", targetRef: "main", title: "Draft change" });
    expect(opened.id).toBeTruthy();
    expect(opened.url).toContain("acme/site/pull/");
    await expect(adapter.mergeChangeRequest(opened.id)).resolves.not.toThrow();
  });

  it("opening a change request twice for the same branch returns the existing PR instead of erroring", async () => {
    await adapter.createBranch("draft-2", "main");
    const first = await adapter.openChangeRequest({ sourceRef: "draft-2", targetRef: "main", title: "Draft change" });
    const second = await adapter.openChangeRequest({ sourceRef: "draft-2", targetRef: "main", title: "Draft change again" });
    expect(second.id).toBe(first.id);
    expect(second.url).toBe(first.url);
  });

  it("commits a base64-encoded binary file and reads its raw bytes back unchanged", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
    const base64 = pngBytes.toString("base64");
    const result = await adapter.commitChange({
      ref: "main",
      baseVersion: null,
      message: "upload image",
      author: AUTHOR,
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

  it("a utf-8 text file committed without an explicit encoding still round-trips through read() as before (default stays utf-8)", async () => {
    await adapter.commitChange({
      ref: "main",
      baseVersion: (await adapter.read("posts/existing.mdx"))!.version,
      message: "update",
      author: AUTHOR,
      writes: [{ path: "posts/existing.mdx", content: "plain text, no encoding specified" }],
    });
    const record = await adapter.read("posts/existing.mdx");
    expect(record?.content).toBe("plain text, no encoding specified");
  });

  it("lists open PRs whose head branch starts with the given prefix", async () => {
    await adapter.createBranch("cimisy/alice/posts/a", "main");
    await adapter.createBranch("cimisy/bob/posts/b", "main");
    await adapter.createBranch("someone-else/unrelated-branch", "main");
    const prA = await adapter.openChangeRequest({ sourceRef: "cimisy/alice/posts/a", targetRef: "main", title: "Alice's draft" });
    await adapter.openChangeRequest({ sourceRef: "cimisy/bob/posts/b", targetRef: "main", title: "Bob's draft" });
    await adapter.openChangeRequest({ sourceRef: "someone-else/unrelated-branch", targetRef: "main", title: "Unrelated PR" });

    const drafts = await adapter.listChangeRequests({ headPrefix: "cimisy/" });
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.sourceRef).sort()).toEqual(["cimisy/alice/posts/a", "cimisy/bob/posts/b"]);
    const found = drafts.find((d) => d.sourceRef === "cimisy/alice/posts/a");
    expect(found).toMatchObject({ id: prA.id, title: "Alice's draft", url: prA.url, state: "open" });
    expect(found?.updatedAt).toBeTruthy();
  });

  it("excludes a merged PR from listChangeRequests once it's no longer open", async () => {
    await adapter.createBranch("cimisy/alice/posts/a", "main");
    const pr = await adapter.openChangeRequest({ sourceRef: "cimisy/alice/posts/a", targetRef: "main", title: "Alice's draft" });
    await adapter.mergeChangeRequest(pr.id);
    const drafts = await adapter.listChangeRequests({ headPrefix: "cimisy/" });
    expect(drafts).toHaveLength(0);
  });

  it("throws a descriptive error when the App isn't installed on the repo", async () => {
    const uninstalledAdapter = new GithubStorageAdapter({
      repo: "someone-else/other-repo",
      appId: "12345",
      privateKey,
      clientId: "client-id",
      clientSecret: "client-secret",
      sessionSecret: "session-secret",
    });
    await expect(uninstalledAdapter.read("posts/x.mdx")).rejects.toThrow(/installed/i);
  });
});
