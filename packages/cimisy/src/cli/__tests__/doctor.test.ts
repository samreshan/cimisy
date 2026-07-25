import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeCimisyConfigBlob } from "../../env/blob.js";
import {
  checkEnvironment,
  doctorExitCode,
  formatDoctorReport,
  loadProjectEnv,
  runDoctor,
  type DoctorCheck,
  type DoctorReport,
  type GithubProbe,
} from "../doctor.js";

/** A genuinely parseable PEM — checkEnvironment does a real createPrivateKey(), not a shape check. */
const REAL_PEM = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const SESSION_SECRET = "0123456789abcdef0123456789abcdef";

function githubEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CIMISY_SOURCE: "github",
    CIMISY_GITHUB_REPO: "acme/site",
    CIMISY_GITHUB_APP_ID: "123",
    CIMISY_GITHUB_APP_PRIVATE_KEY: REAL_PEM,
    CIMISY_GITHUB_APP_CLIENT_ID: "Iv1.abc",
    CIMISY_GITHUB_APP_CLIENT_SECRET: "cs_secret",
    CIMISY_SESSION_SECRET: SESSION_SECRET,
    ...overrides,
  };
}

function find(checks: DoctorCheck[], id: string): DoctorCheck {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check "${id}" in: ${checks.map((c) => c.id).join(", ")}`);
  return check;
}

function healthyProbe(overrides: Partial<GithubProbe> = {}): GithubProbe {
  return {
    appMetadata: async () => ({ slug: "cimisy-site", name: "cimisy-site" }),
    repoInstallation: async () => ({
      id: 999,
      permissions: { contents: "write", pull_requests: "write", metadata: "read", members: "read" },
      account: { login: "acme", type: "User" },
    }),
    branchExists: async () => true,
    collaboratorPermission: async () => "admin",
    ...overrides,
  };
}

function notFound(): Error {
  return Object.assign(new Error("Not Found"), { status: 404 });
}

describe("checkEnvironment — local mode", () => {
  it("passes and skips the GitHub checks", () => {
    const { checks, mode, options } = checkEnvironment({});
    expect(mode).toBe("local");
    expect(options).toBeUndefined();
    expect(find(checks, "env.resolve").status).toBe("pass");
    expect(find(checks, "env.github").status).toBe("skip");
    // Local dev has no serverless rate-limiter concern to warn about.
    expect(checks.some((c) => c.id === "env.rateLimiter")).toBe(false);
  });
});

describe("checkEnvironment — github mode", () => {
  it("passes a complete configuration and reports which form it came from", () => {
    const fromVars = checkEnvironment(githubEnv());
    expect(fromVars.mode).toBe("github");
    expect(find(fromVars.checks, "env.resolve").detail).toContain("individual");
    expect(find(fromVars.checks, "env.github").detail).toBe("acme/site @ main");
    expect(find(fromVars.checks, "env.sessionSecret").status).toBe("pass");
    expect(find(fromVars.checks, "env.privateKey").status).toBe("pass");

    const blob = encodeCimisyConfigBlob({
      repo: "acme/site",
      appId: "123",
      privateKey: REAL_PEM,
      clientId: "Iv1.abc",
      clientSecret: "cs",
      sessionSecret: SESSION_SECRET,
    });
    expect(find(checkEnvironment({ CIMISY_CONFIG: blob }).checks, "env.resolve").detail).toContain("CIMISY_CONFIG");
  });

  it("fails with the exact missing variable names and points at the wizard", () => {
    const env = githubEnv();
    delete env.CIMISY_GITHUB_APP_CLIENT_SECRET;
    delete env.CIMISY_SESSION_SECRET;
    const check = find(checkEnvironment(env).checks, "env.github");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("CIMISY_GITHUB_APP_CLIENT_SECRET");
    expect(check.detail).toContain("CIMISY_SESSION_SECRET");
    expect(check.fix).toContain("cimisy setup github");
  });

  it("fails a short session secret, reporting its length but never its value", () => {
    const check = find(checkEnvironment(githubEnv({ CIMISY_SESSION_SECRET: "too-short" })).checks, "env.sessionSecret");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("9 characters");
    expect(check.detail).not.toContain("too-short");
  });

  it("fails a mangled PEM — the newline-eaten case a shape check would miss", () => {
    const mangled = REAL_PEM.replace(/\n/g, " ");
    const check = find(checkEnvironment(githubEnv({ CIMISY_GITHUB_APP_PRIVATE_KEY: mangled })).checks, "env.privateKey");
    expect(check.status).toBe("fail");
    expect(check.fix).toContain("CIMISY_CONFIG");
  });

  it("accepts a \\n-escaped single-line PEM", () => {
    const escaped = REAL_PEM.replace(/\n/g, "\\n");
    expect(find(checkEnvironment(githubEnv({ CIMISY_GITHUB_APP_PRIVATE_KEY: escaped })).checks, "env.privateKey").status).toBe("pass");
  });

  it("reports a malformed blob as unresolved rather than as missing vars", () => {
    const { checks, mode } = checkEnvironment({ CIMISY_CONFIG: "!!!!" });
    expect(mode).toBe("unresolved");
    expect(find(checks, "env.resolve").status).toBe("fail");
  });

  it("warns — never fails — when no shared rate-limit store is configured", () => {
    expect(find(checkEnvironment(githubEnv()).checks, "env.rateLimiter").status).toBe("warn");
    expect(find(checkEnvironment(githubEnv({ UPSTASH_REDIS_REST_URL: "https://x" })).checks, "env.rateLimiter").status).toBe("pass");
    expect(find(checkEnvironment(githubEnv({ KV_REST_API_URL: "https://x" })).checks, "env.rateLimiter").status).toBe("pass");
  });

  it("surfaces the blob-wins precedence warning as a check", () => {
    const blob = encodeCimisyConfigBlob({
      repo: "acme/site",
      appId: "123",
      privateKey: REAL_PEM,
      clientId: "Iv1.abc",
      clientSecret: "cs",
      sessionSecret: SESSION_SECRET,
    });
    const check = find(checkEnvironment(githubEnv({ CIMISY_CONFIG: blob })).checks, "env.precedence");
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("CIMISY_GITHUB_REPO");
  });
});

describe("runDoctor — GitHub checks", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-doctor-"));
    await mkdir(path.join(root, "app", "(cimisy)", "admin", "[[...segments]]"), { recursive: true });
    await mkdir(path.join(root, "app", "api", "cimisy", "[...route]"), { recursive: true });
    await writeFile(path.join(root, "app", "(cimisy)", "admin", "[[...segments]]", "page.tsx"), "export default function P() {}\n");
    await writeFile(path.join(root, "app", "api", "cimisy", "[...route]", "route.ts"), "export const GET = () => {};\n");
    await writeFile(path.join(root, "cimisy.config.ts"), 'import { resolveSourceFromEnv } from "cimisy/env";\nexport default config({ source: resolveSourceFromEnv({ contentDir: "./content" }) });\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("passes every check against a healthy configuration", async () => {
    const report = await runDoctor({ projectRoot: root, env: githubEnv(), createProbe: () => healthyProbe() });
    expect(report.ok).toBe(true);
    expect(report.mode).toBe("github");
    expect(doctorExitCode(report)).toBe(0);
    for (const id of ["github.appAuth", "github.installation", "github.permission.contents", "github.permission.pull_requests", "github.branch", "github.collaborator", "project.config", "project.routes"]) {
      expect(find(report.checks, id).status).toBe("pass");
    }
  });

  it("stops after an App-auth failure instead of cascading identical errors", async () => {
    const report = await runDoctor({
      projectRoot: root,
      env: githubEnv(),
      createProbe: () => healthyProbe({ appMetadata: async () => Promise.reject(new Error("Bad credentials")) }),
    });
    expect(find(report.checks, "github.appAuth").status).toBe("fail");
    expect(report.checks.some((c) => c.id === "github.installation")).toBe(false);
    expect(doctorExitCode(report)).toBe(1);
  });

  it("reports a not-yet-installed App distinctly from a broken one", async () => {
    const report = await runDoctor({
      projectRoot: root,
      env: githubEnv(),
      createProbe: () => healthyProbe({ repoInstallation: async () => Promise.reject(notFound()) }),
    });
    const check = find(report.checks, "github.installation");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("no installation found on acme/site");
    expect(check.fix).toContain("Install App");
  });

  it("fails a declined permission — requested by the manifest is not the same as granted", async () => {
    const report = await runDoctor({
      projectRoot: root,
      env: githubEnv(),
      createProbe: () =>
        healthyProbe({
          repoInstallation: async () => ({ id: 1, permissions: { contents: "read" }, account: { login: "acme", type: "User" } }),
        }),
    });
    expect(find(report.checks, "github.permission.contents").detail).toBe('granted "read", need "write"');
    expect(find(report.checks, "github.permission.pull_requests").detail).toBe('granted "none", need "write"');
    expect(report.ok).toBe(false);
  });

  it("fails a missing branch and names the variable to change", async () => {
    const report = await runDoctor({
      projectRoot: root,
      env: githubEnv({ CIMISY_GITHUB_BRANCH: "trunk" }),
      createProbe: () => healthyProbe({ branchExists: async () => false }),
    });
    const check = find(report.checks, "github.branch");
    expect(check.status).toBe("fail");
    expect(check.detail).toContain('no branch "trunk"');
    expect(check.fix).toContain("CIMISY_GITHUB_BRANCH");
  });

  it("treats a missing collaborator entry as expected for an org, but a warning for a user", async () => {
    const org = await runDoctor({
      projectRoot: root,
      env: githubEnv(),
      createProbe: () =>
        healthyProbe({
          repoInstallation: async () => ({ id: 1, permissions: { contents: "write", pull_requests: "write" }, account: { login: "acme", type: "Organization" } }),
          collaboratorPermission: async () => null,
        }),
    });
    expect(find(org.checks, "github.collaborator").status).toBe("pass");

    const user = await runDoctor({
      projectRoot: root,
      env: githubEnv(),
      createProbe: () => healthyProbe({ collaboratorPermission: async () => null }),
    });
    expect(find(user.checks, "github.collaborator").status).toBe("warn");
    expect(user.ok).toBe(true);
  });

  it("skips every GitHub round trip when the env is incomplete", async () => {
    const env = githubEnv();
    delete env.CIMISY_GITHUB_APP_ID;
    const createProbe = vi.fn(() => healthyProbe());
    const report = await runDoctor({ projectRoot: root, env, createProbe });
    expect(createProbe).not.toHaveBeenCalled();
    expect(report.checks.some((c) => c.id.startsWith("github."))).toBe(false);
    // Project wiring is still checked — one run should report everything it can.
    expect(find(report.checks, "project.routes").status).toBe("pass");
  });

  it("warns when the config hard-wires githubSource but the environment resolves to local", async () => {
    await writeFile(path.join(root, "cimisy.config.ts"), 'export default config({ source: githubSource({ repo: process.env.CIMISY_GITHUB_REPO! }) });\n');
    const local = await runDoctor({ projectRoot: root, env: {}, createProbe: () => healthyProbe() });
    expect(find(local.checks, "project.sourceMismatch").status).toBe("warn");
    // ...and stays quiet once the environment actually is GitHub.
    const configured = await runDoctor({ projectRoot: root, env: githubEnv(), createProbe: () => healthyProbe() });
    expect(configured.checks.some((c) => c.id === "project.sourceMismatch")).toBe(false);
  });

  it("fails project wiring when the routes aren't mounted", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "cimisy-doctor-bare-"));
    try {
      await mkdir(path.join(bare, "app"), { recursive: true });
      const report = await runDoctor({ projectRoot: bare, env: {}, createProbe: () => healthyProbe() });
      expect(find(report.checks, "project.config").status).toBe("fail");
      expect(find(report.checks, "project.routes").status).toBe("fail");
      expect(doctorExitCode(report)).toBe(1);
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});

describe("loadProjectEnv", () => {
  it("layers .env then .env.local, with the real process environment winning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cimisy-doctor-env-"));
    try {
      await writeFile(path.join(root, ".env"), "CIMISY_GITHUB_REPO=from/dotenv\nCIMISY_GITHUB_BRANCH=from-dotenv\n");
      await writeFile(path.join(root, ".env.local"), 'CIMISY_GITHUB_REPO="from/local"\n');
      const env = await loadProjectEnv(root, { CIMISY_GITHUB_BRANCH: "from-process" });
      expect(env.CIMISY_GITHUB_REPO).toBe("from/local");
      expect(env.CIMISY_GITHUB_BRANCH).toBe("from-process");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is fine with no env files at all", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cimisy-doctor-noenv-"));
    try {
      await expect(loadProjectEnv(root, {})).resolves.toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("formatDoctorReport", () => {
  const report: DoctorReport = {
    ok: false,
    mode: "github",
    checks: [
      { id: "a", label: "Passing thing", status: "pass", detail: "fine", fix: "should not be shown" },
      { id: "b", label: "Broken thing", status: "fail", detail: "why", fix: "do this" },
      { id: "c", label: "Iffy thing", status: "warn", detail: "hmm" },
      { id: "d", label: "Skipped thing", status: "skip" },
    ],
  };

  it("marks each status and shows fix hints only where they're actionable", () => {
    const output = formatDoctorReport(report);
    expect(output).toContain("✔ Passing thing — fine");
    expect(output).not.toContain("should not be shown");
    expect(output).toContain("✖ Broken thing — why\n    → do this");
    expect(output).toContain("! Iffy thing — hmm");
    expect(output).toContain("– Skipped thing");
    expect(output).toContain("1 check failed");
  });

  it("summarizes a clean run, counting warnings separately", () => {
    expect(formatDoctorReport({ ok: true, mode: "local", checks: [{ id: "a", label: "x", status: "pass" }] })).toContain("All checks passed");
    expect(formatDoctorReport({ ok: true, mode: "local", checks: [{ id: "a", label: "x", status: "warn" }] })).toContain("All checks passed (1 warning)");
  });
});
