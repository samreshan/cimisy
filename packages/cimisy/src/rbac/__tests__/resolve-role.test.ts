import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubSource } from "../../adapters/github/adapter.js";
import { createFakeGithubApi, type FakeGithubApi } from "../../adapters/github/__tests__/fake-github-api.js";
import { DEFAULT_ROLES, type RoleDefinition } from "../../config/define-config.js";
import { ForbiddenError } from "../../shared/errors.js";
import type { GithubIntegratedSource } from "../../shared/github-source-shape.js";
import { resolveRole } from "../resolve-role.js";
import { USERS_FILE_PATH } from "../user-store.js";

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
    sessionSecret: "session-secret",
  });
}

function seedRoster(fake: FakeGithubApi, records: Array<{ githubId: string; githubLogin: string; role: string | null }>): void {
  const now = new Date(0).toISOString();
  const lines = records
    .map(
      (r) =>
        `- githubId: "${r.githubId}"\n  githubLogin: ${r.githubLogin}\n  name: ${r.githubLogin}\n  role: ${r.role ?? "null"}\n  addedAt: "${now}"\n  updatedAt: "${now}"\n  updatedBy: system\n`,
    )
    .join("");
  fake.seedFile(USERS_FILE_PATH, lines || "[]\n");
}

describe("rbac/resolve-role", () => {
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

  it("returns a full-access local-admin role when there is no GitHub source (local mode)", async () => {
    const resolved = await resolveRole({}, null, "anyone", "0");
    expect(resolved?.roleName).toBe("local-admin");
    expect(resolved?.role.directPublish).toBe(true);
  });

  it("resolves the role assigned in the roster, keyed by githubId (not login)", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "editor" }]);
    const resolved = await resolveRole({}, source, "alice", "1");
    expect(resolved?.roleName).toBe("editor");
    expect(resolved?.role).toEqual(DEFAULT_ROLES.editor);
  });

  it("returns null (not a thrown error) for a signed-in user with no assigned role", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: null }]);
    const resolved = await resolveRole({}, source, "alice", "1");
    expect(resolved).toBeNull();
  });

  it("returns null for a githubId that isn't in the roster at all", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "admin" }]);
    const resolved = await resolveRole({}, source, "stranger", "999");
    expect(resolved).toBeNull();
  });

  it("resolves against a login change: an existing user id keeps their role even if their login changed since assignment", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice-renamed", role: "publisher" }]);
    const resolved = await resolveRole({}, source, "alice-old-name", "1");
    expect(resolved?.roleName).toBe("publisher");
  });

  it("throws a clear ForbiddenError when the roster's role name has no definition in cimisy.config.ts's roles", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "ghost-role" }]);
    await expect(resolveRole({ roles: { admin: DEFAULT_ROLES.admin as RoleDefinition } }, source, "alice", "1")).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("uses the config's custom roles map instead of DEFAULT_ROLES when provided", async () => {
    seedRoster(fake, [{ githubId: "1", githubLogin: "alice", role: "custom" }]);
    const custom: RoleDefinition = { directPublish: false, rules: [{ path: "docs/**", actions: ["read"] }] };
    const resolved = await resolveRole({ roles: { custom } }, source, "alice", "1");
    expect(resolved?.role).toBe(custom);
  });
});
