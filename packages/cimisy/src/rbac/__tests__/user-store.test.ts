import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { githubSource } from "../../adapters/github/adapter.js";
import { createFakeGithubApi, type FakeGithubApi } from "../../adapters/github/__tests__/fake-github-api.js";
import { DEFAULT_ROLE_MAPPING } from "../../config/define-config.js";
import { ValidationError } from "../../shared/errors.js";
import type { GithubIntegratedSource } from "../../shared/github-source-shape.js";
import { ensureUserRecord, readUserRoster, USERS_FILE_PATH, writeUserRoster, type UserRecord } from "../user-store.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

function makeSource(fake: FakeGithubApi): GithubIntegratedSource {
  return githubSource({
    repo: `${fake.owner}/${fake.repo}`,
    branch: "main",
    appId: "1",
    privateKey,
    clientId: "client-id",
    clientSecret: "client-secret",
    sessionSecret: "session-secret-0123456789abcdef0",
  });
}

const AUTHOR = { id: "1", name: "Test", email: "test@example.com" };

describe("rbac/user-store", () => {
  let fake: FakeGithubApi;
  let source: GithubIntegratedSource;

  beforeEach(() => {
    fake = createFakeGithubApi({ owner: "acme", repo: "site", initialFiles: {} });
    fake.install();
    source = makeSource(fake);
  });

  afterEach(() => {
    fake.restore();
  });

  describe("readUserRoster", () => {
    it("returns an empty roster with a null version when the file doesn't exist yet", async () => {
      const roster = await readUserRoster(source);
      expect(roster.users).toEqual([]);
      expect(roster.version).toBeNull();
    });

    it("parses an existing roster file", async () => {
      const record: UserRecord = {
        githubId: "1",
        githubLogin: "alice",
        name: "Alice",
        role: "admin",
        addedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        updatedBy: "system",
      };
      fake.seedFile(USERS_FILE_PATH, `- githubId: "${record.githubId}"\n  githubLogin: ${record.githubLogin}\n  name: ${record.name}\n  role: ${record.role}\n  addedAt: "${record.addedAt}"\n  updatedAt: "${record.updatedAt}"\n  updatedBy: ${record.updatedBy}\n`);
      const roster = await readUserRoster(source);
      expect(roster.users).toEqual([record]);
      expect(roster.version).toBeTruthy();
    });

    it("fails closed on malformed YAML rather than silently dropping the roster", async () => {
      fake.seedFile(USERS_FILE_PATH, "- githubId: [unterminated\n");
      await expect(readUserRoster(source)).rejects.toThrow(ValidationError);
    });

    it("fails closed when the file parses but isn't a list", async () => {
      fake.seedFile(USERS_FILE_PATH, "not: a-list\n");
      await expect(readUserRoster(source)).rejects.toThrow(ValidationError);
    });

    it("caches reads within the TTL, and bypassCache forces a fresh read", async () => {
      const first = await readUserRoster(source);
      expect(first.users).toEqual([]);

      // Mutate the underlying file directly (not through writeUserRoster,
      // which would invalidate the cache) — the next plain read should
      // still see the stale cached value...
      fake.seedFile(USERS_FILE_PATH, "[]\n");
      const requestCountBeforeCachedRead = fake.requests.length;
      await readUserRoster(source);
      expect(fake.requests.length).toBe(requestCountBeforeCachedRead); // no network call — served from cache

      // ...but bypassCache always re-fetches.
      const requestCountBeforeBypass = fake.requests.length;
      await readUserRoster(source, { bypassCache: true });
      expect(fake.requests.length).toBeGreaterThan(requestCountBeforeBypass);
    });

    it("scopes the cache per source instance, not globally", async () => {
      // Populate source A's cache with an empty roster.
      await readUserRoster(source);

      // A second, distinct source pointing at a repo that already has a
      // non-empty roster must not see source A's cached (empty) result.
      const fakeB = createFakeGithubApi({ owner: "acme", repo: "other", initialFiles: {} });
      fakeB.install();
      try {
        const sourceB = makeSource(fakeB);
        fakeB.seedFile(
          USERS_FILE_PATH,
          "- githubId: \"9\"\n  githubLogin: nine\n  name: Nine\n  role: admin\n  addedAt: \"1970-01-01T00:00:00.000Z\"\n  updatedAt: \"1970-01-01T00:00:00.000Z\"\n  updatedBy: system\n",
        );
        const rosterB = await readUserRoster(sourceB);
        expect(rosterB.users).toHaveLength(1);
        expect(rosterB.users[0]?.githubLogin).toBe("nine");
      } finally {
        fakeB.restore();
      }
    });
  });

  describe("writeUserRoster", () => {
    it("commits the roster as YAML and makes it readable afterward", async () => {
      const record: UserRecord = {
        githubId: "1",
        githubLogin: "alice",
        name: "Alice",
        role: "admin",
        addedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        updatedBy: "system",
      };
      const result = await writeUserRoster(source, [record], null, AUTHOR, "add alice", "main");
      expect(result.conflict).toBeUndefined();

      const fileContent = fake.filesOnBranch("main").get(USERS_FILE_PATH);
      expect(fileContent).toBeTruthy();
      expect(parseYaml(fileContent!)).toEqual([record]);
    });

    it("invalidates the cache so a subsequent plain read sees the new content", async () => {
      await readUserRoster(source); // populate cache with empty roster
      await writeUserRoster(
        source,
        [
          {
            githubId: "1",
            githubLogin: "alice",
            name: "Alice",
            role: "admin",
            addedAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            updatedBy: "system",
          },
        ],
        null,
        AUTHOR,
        "add alice",
        "main",
      );
      const roster = await readUserRoster(source);
      expect(roster.users).toHaveLength(1);
    });

    it("reports a conflict instead of clobbering a concurrent write", async () => {
      const first = await writeUserRoster(
        source,
        [{ githubId: "1", githubLogin: "alice", name: "Alice", role: "admin", addedAt: "t", updatedAt: "t", updatedBy: "system" }],
        null,
        AUTHOR,
        "add alice",
        "main",
      );
      expect(first.conflict).toBeUndefined();

      // Second write still using the stale (null) baseVersion — simulates
      // two concurrent callers racing on the same file.
      const second = await writeUserRoster(
        source,
        [{ githubId: "2", githubLogin: "bob", name: "Bob", role: "editor", addedAt: "t", updatedAt: "t", updatedBy: "system" }],
        null,
        AUTHOR,
        "add bob",
        "main",
      );
      expect(second.conflict).toBeDefined();
    });
  });

  describe("ensureUserRecord", () => {
    it("bootstraps the very first sign-in as admin when their GitHub collaborator permission maps to admin", async () => {
      fake.setCollaboratorPermission("alice", "admin");
      await ensureUserRecord(source, { githubId: "1", githubLogin: "alice", name: "Alice" }, "main", DEFAULT_ROLE_MAPPING);

      const { users } = await readUserRoster(source, { bypassCache: true });
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ githubId: "1", githubLogin: "alice", role: "admin" });
    });

    it("does not bootstrap the first sign-in as admin when their GitHub permission doesn't map to admin", async () => {
      fake.setCollaboratorPermission("alice", "read");
      await ensureUserRecord(source, { githubId: "1", githubLogin: "alice", name: "Alice" }, "main", DEFAULT_ROLE_MAPPING);

      const { users } = await readUserRoster(source, { bypassCache: true });
      expect(users).toHaveLength(1);
      expect(users[0]?.role).toBeNull();
    });

    it("registers every subsequent sign-in as pending, even one with admin GitHub permission", async () => {
      fake.setCollaboratorPermission("alice", "admin");
      await ensureUserRecord(source, { githubId: "1", githubLogin: "alice", name: "Alice" }, "main", DEFAULT_ROLE_MAPPING);

      fake.setCollaboratorPermission("carol", "admin");
      await ensureUserRecord(source, { githubId: "2", githubLogin: "carol", name: "Carol" }, "main", DEFAULT_ROLE_MAPPING);

      const { users } = await readUserRoster(source, { bypassCache: true });
      expect(users).toHaveLength(2);
      const carol = users.find((u) => u.githubId === "2");
      expect(carol?.role).toBeNull(); // pending, despite being a GitHub admin too
    });

    it("refreshes login/name on an existing record without touching its role", async () => {
      fake.setCollaboratorPermission("alice", "admin");
      await ensureUserRecord(source, { githubId: "1", githubLogin: "alice", name: "Alice" }, "main", DEFAULT_ROLE_MAPPING);

      await ensureUserRecord(source, { githubId: "1", githubLogin: "alice-renamed", name: "Alice R." }, "main", DEFAULT_ROLE_MAPPING);

      const { users } = await readUserRoster(source, { bypassCache: true });
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({ githubLogin: "alice-renamed", name: "Alice R.", role: "admin" });
    });

    it("is a no-op (no write) when login and name are already up to date", async () => {
      fake.setCollaboratorPermission("alice", "admin");
      await ensureUserRecord(source, { githubId: "1", githubLogin: "alice", name: "Alice" }, "main", DEFAULT_ROLE_MAPPING);

      const requestCountBefore = fake.requests.length;
      await ensureUserRecord(source, { githubId: "1", githubLogin: "alice", name: "Alice" }, "main", DEFAULT_ROLE_MAPPING);
      // Only the bypassCache roster read happens — no blob/tree/commit/ref writes.
      const writeRequests = fake.requests
        .slice(requestCountBefore)
        .filter((r) => r.method === "POST" || r.method === "PATCH");
      expect(writeRequests).toEqual([]);
    });
  });
});
