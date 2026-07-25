import { afterEach, describe, expect, it, vi } from "vitest";
import { CimisyError } from "../../shared/errors.js";
import { encodeCimisyConfigBlob, type CimisyConfigBlobInput } from "../blob.js";
import { readSourceEnv, type EnvRecord } from "../read-env.js";
import { resolveSourceFromEnv } from "../resolve-source.js";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\n";
const ESCAPED_PEM = PEM.replace(/\n/g, "\\n");
const SESSION_SECRET = "0123456789abcdef0123456789abcdef";

const BLOB_INPUT: CimisyConfigBlobInput = {
  repo: "acme/site",
  branch: "release",
  appId: "42",
  privateKey: PEM,
  clientId: "Iv1.blob",
  clientSecret: "blob-secret",
  sessionSecret: SESSION_SECRET,
};

/** A complete set of individual vars — tests delete from this to exercise each missing-var combination. */
function completeVars(): EnvRecord {
  return {
    CIMISY_SOURCE: "github",
    CIMISY_GITHUB_REPO: "acme/vars",
    CIMISY_GITHUB_APP_ID: "7",
    CIMISY_GITHUB_APP_PRIVATE_KEY: PEM,
    CIMISY_GITHUB_APP_CLIENT_ID: "Iv1.vars",
    CIMISY_GITHUB_APP_CLIENT_SECRET: "vars-secret",
    CIMISY_SESSION_SECRET: SESSION_SECRET,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readSourceEnv — mode selection", () => {
  it("falls back to local when neither the switch nor the blob is set", () => {
    expect(readSourceEnv({})).toEqual({ mode: "local", allowInProduction: false, warnings: [] });
  });

  it("stays local for any CIMISY_SOURCE value other than exactly \"github\"", () => {
    for (const value of ["local", "GitHub", "github ", "1", ""]) {
      expect(readSourceEnv({ CIMISY_SOURCE: value }).mode).toBe(value.trim() === "github" ? "github" : "local");
    }
  });

  it("passes CIMISY_ALLOW_LOCAL_PROD through only for the exact string \"true\"", () => {
    expect(readSourceEnv({ CIMISY_ALLOW_LOCAL_PROD: "true" })).toMatchObject({ mode: "local", allowInProduction: true });
    expect(readSourceEnv({ CIMISY_ALLOW_LOCAL_PROD: "1" })).toMatchObject({ mode: "local", allowInProduction: false });
    expect(readSourceEnv({ CIMISY_ALLOW_LOCAL_PROD: "yes" })).toMatchObject({ mode: "local", allowInProduction: false });
  });

  it("selects github from CIMISY_CONFIG alone, with no CIMISY_SOURCE switch", () => {
    const resolution = readSourceEnv({ CIMISY_CONFIG: encodeCimisyConfigBlob(BLOB_INPUT) });
    expect(resolution).toMatchObject({ mode: "github", origin: "blob", missing: [] });
  });
});

describe("readSourceEnv — precedence", () => {
  it("lets the blob win over individual vars, and says so exactly once", () => {
    const resolution = readSourceEnv({ ...completeVars(), CIMISY_CONFIG: encodeCimisyConfigBlob(BLOB_INPUT) });
    expect(resolution.mode).toBe("github");
    if (resolution.mode !== "github") throw new Error("unreachable");
    expect(resolution.origin).toBe("blob");
    expect(resolution.options?.repo).toBe("acme/site");
    expect(resolution.options?.clientSecret).toBe("blob-secret");
    expect(resolution.warnings).toHaveLength(1);
    expect(resolution.warnings[0]).toContain("CIMISY_CONFIG");
    expect(resolution.warnings[0]).toContain("CIMISY_GITHUB_REPO");
  });

  it("warns about nothing when only the blob is set", () => {
    expect(readSourceEnv({ CIMISY_CONFIG: encodeCimisyConfigBlob(BLOB_INPUT) }).warnings).toEqual([]);
  });

  it("never merges the two forms — a var absent from the blob does not fill in from the environment", () => {
    const noBranch = { ...BLOB_INPUT };
    delete noBranch.branch;
    const resolution = readSourceEnv({
      CIMISY_CONFIG: encodeCimisyConfigBlob(noBranch),
      CIMISY_GITHUB_BRANCH: "from-env",
    });
    if (resolution.mode !== "github") throw new Error("unreachable");
    expect(resolution.options?.branch).toBe("main");
  });

  it("propagates a malformed blob as a hard error rather than treating it as incomplete", () => {
    expect(() => readSourceEnv({ CIMISY_CONFIG: "!!!not-base64!!!" })).toThrow(CimisyError);
  });
});

describe("readSourceEnv — individual vars", () => {
  it("resolves a complete set, defaulting branch to main", () => {
    const resolution = readSourceEnv(completeVars());
    if (resolution.mode !== "github") throw new Error("unreachable");
    expect(resolution.origin).toBe("vars");
    expect(resolution.options).toEqual({
      repo: "acme/vars",
      branch: "main",
      appId: "7",
      privateKey: PEM.trim(),
      clientId: "Iv1.vars",
      clientSecret: "vars-secret",
      sessionSecret: SESSION_SECRET,
    });
  });

  it("honors an explicit CIMISY_GITHUB_BRANCH", () => {
    const resolution = readSourceEnv({ ...completeVars(), CIMISY_GITHUB_BRANCH: "trunk" });
    if (resolution.mode !== "github") throw new Error("unreachable");
    expect(resolution.options?.branch).toBe("trunk");
  });

  it("names exactly the missing var for each single omission", () => {
    const cases: Array<[keyof EnvRecord, string]> = [
      ["CIMISY_GITHUB_REPO", "CIMISY_GITHUB_REPO"],
      ["CIMISY_GITHUB_APP_ID", "CIMISY_GITHUB_APP_ID"],
      ["CIMISY_GITHUB_APP_PRIVATE_KEY", "CIMISY_GITHUB_APP_PRIVATE_KEY"],
      ["CIMISY_GITHUB_APP_CLIENT_ID", "CIMISY_GITHUB_APP_CLIENT_ID"],
      ["CIMISY_GITHUB_APP_CLIENT_SECRET", "CIMISY_GITHUB_APP_CLIENT_SECRET"],
      ["CIMISY_SESSION_SECRET", "CIMISY_SESSION_SECRET"],
    ];
    for (const [omitted, expected] of cases) {
      const env = completeVars();
      delete env[omitted as string];
      const resolution = readSourceEnv(env);
      if (resolution.mode !== "github") throw new Error("unreachable");
      expect(resolution.missing).toEqual([expected]);
      expect(resolution.options).toBeUndefined();
    }
  });

  it("reports every missing var at once, in canonical order", () => {
    const resolution = readSourceEnv({ CIMISY_SOURCE: "github" });
    if (resolution.mode !== "github") throw new Error("unreachable");
    expect(resolution.missing).toEqual([
      "CIMISY_GITHUB_REPO",
      "CIMISY_GITHUB_APP_ID",
      "CIMISY_GITHUB_APP_PRIVATE_KEY",
      "CIMISY_GITHUB_APP_CLIENT_ID",
      "CIMISY_GITHUB_APP_CLIENT_SECRET",
      "CIMISY_SESSION_SECRET",
    ]);
  });

  it("treats a blank or whitespace-only var as missing, not as set-to-empty", () => {
    const resolution = readSourceEnv({ ...completeVars(), CIMISY_GITHUB_APP_ID: "   " });
    if (resolution.mode !== "github") throw new Error("unreachable");
    expect(resolution.missing).toEqual(["CIMISY_GITHUB_APP_ID"]);
  });

  it("resolves the escaped and multi-line forms of the same PEM to the identical string", () => {
    const escaped = readSourceEnv({ ...completeVars(), CIMISY_GITHUB_APP_PRIVATE_KEY: ESCAPED_PEM });
    const multiline = readSourceEnv(completeVars());
    if (escaped.mode !== "github" || multiline.mode !== "github") throw new Error("unreachable");
    expect(escaped.options?.privateKey).toBe(PEM.trim());
    expect(multiline.options?.privateKey).toBe(PEM.trim());
    expect(escaped.options?.privateKey).toContain("\n");
  });
});

describe("resolveSourceFromEnv", () => {
  it("builds the local adapter rooted at contentDir", () => {
    const source = resolveSourceFromEnv({ contentDir: "content", env: {} });
    expect(source.kind).toBe("local");
  });

  it("builds the GitHub adapter from individual vars", () => {
    const source = resolveSourceFromEnv({ contentDir: "content", env: completeVars() });
    expect(source.kind).toBe("github");
  });

  it("builds the GitHub adapter from the blob, honoring its branch", () => {
    const source = resolveSourceFromEnv({ contentDir: "content", env: { CIMISY_CONFIG: encodeCimisyConfigBlob(BLOB_INPUT) } });
    expect(source.kind).toBe("github");
    expect((source as { defaultBranch?: string }).defaultBranch).toBe("release");
  });

  it("throws a typed MISSING_GITHUB_CONFIG naming the missing vars and pointing at the wizard", () => {
    const env = completeVars();
    delete env.CIMISY_GITHUB_APP_CLIENT_SECRET;
    try {
      resolveSourceFromEnv({ contentDir: "content", env });
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CimisyError);
      expect((err as CimisyError).code).toBe("MISSING_GITHUB_CONFIG");
      expect((err as Error).message).toContain("CIMISY_GITHUB_APP_CLIENT_SECRET");
      expect((err as Error).message).toContain("cimisy setup github");
    }
  });

  it("logs the blob-wins warning through console.warn, once, without any secret in it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveSourceFromEnv({ contentDir: "content", env: { ...completeVars(), CIMISY_CONFIG: encodeCimisyConfigBlob(BLOB_INPUT) } });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("[cimisy]");
    expect(message).not.toContain("blob-secret");
    expect(message).not.toContain(SESSION_SECRET);
  });

  it("defaults to process.env when no env is injected", () => {
    // The real environment has no CIMISY_* vars under vitest — local fallback.
    expect(resolveSourceFromEnv({ contentDir: "content" }).kind).toBe("local");
  });
});
