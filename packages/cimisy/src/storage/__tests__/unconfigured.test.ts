import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSourceFromEnv } from "../../env/resolve-source.js";
import { CimisyError } from "../../shared/errors.js";
import { isUnconfiguredSource, unconfiguredSource } from "../unconfigured.js";

const MISSING = ["CIMISY_GITHUB_APP_ID", "CIMISY_SESSION_SECRET"];

describe("unconfiguredSource", () => {
  const source = unconfiguredSource({ missing: MISSING });

  it("reports its kind and the missing names, and declares no capabilities", () => {
    expect(source.kind).toBe("unconfigured");
    expect(source.missing).toEqual(MISSING);
    expect(source.capabilities).toEqual({ branching: false, pullRequests: false, history: false });
  });

  it("is recognized structurally, not by instanceof", () => {
    expect(isUnconfiguredSource(source)).toBe(true);
    expect(isUnconfiguredSource({ kind: "unconfigured" })).toBe(true);
    expect(isUnconfiguredSource({ kind: "local" })).toBe(false);
    expect(isUnconfiguredSource({ kind: "github" })).toBe(false);
  });

  it("throws a typed error on every content operation — a placeholder, never a silent fallback", async () => {
    const operations = [
      () => source.read("content/posts/a.mdx"),
      () => source.list("content/posts"),
      () => source.commitChange({ ref: "main", baseVersion: null, message: "m", author: { id: "1", name: "n", email: "e" }, writes: [] }),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toThrow(CimisyError);
      await expect(operation()).rejects.toThrow(/not configured/i);
    }
  });

  it("names the missing variables in the error, and nothing else", async () => {
    let error: CimisyError | undefined;
    try {
      await source.read("x");
    } catch (err) {
      error = err as CimisyError;
    }
    expect(error?.code).toBe("SOURCE_UNCONFIGURED");
    expect(error?.message).toContain("CIMISY_GITHUB_APP_ID");
    expect(error?.message).toContain("cimisy setup github");
  });

  it("copies the missing list rather than aliasing the caller's array", () => {
    const mutable = ["A"];
    const created = unconfiguredSource({ missing: mutable });
    mutable.push("B");
    expect(created.missing).toEqual(["A"]);
  });
});

describe("resolveSourceFromEnv onIncomplete", () => {
  const incomplete = { CIMISY_SOURCE: "github", CIMISY_GITHUB_REPO: "acme/site" };

  it("throws by default, preserving fail-fast for anyone who wants it", () => {
    expect(() => resolveSourceFromEnv({ contentDir: "content", env: incomplete })).toThrow(CimisyError);
    expect(() => resolveSourceFromEnv({ contentDir: "content", env: incomplete, onIncomplete: "throw" })).toThrow(CimisyError);
  });

  it('returns the placeholder under onIncomplete: "placeholder", carrying the missing names', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const source = resolveSourceFromEnv({ contentDir: "content", env: incomplete, onIncomplete: "placeholder" });
      expect(isUnconfiguredSource(source)).toBe(true);
      expect(isUnconfiguredSource(source) && source.missing).toEqual([
        "CIMISY_GITHUB_APP_ID",
        "CIMISY_GITHUB_APP_PRIVATE_KEY",
        "CIMISY_GITHUB_APP_CLIENT_ID",
        "CIMISY_GITHUB_APP_CLIENT_SECRET",
        "CIMISY_SESSION_SECRET",
      ]);
      // Silent degradation would be the worst outcome — it must say so.
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("still throws on a *malformed* blob under placeholder — corrupt is not incomplete", () => {
    expect(() => resolveSourceFromEnv({ contentDir: "content", env: { CIMISY_CONFIG: "!!!" }, onIncomplete: "placeholder" })).toThrow(CimisyError);
  });

  it("never yields a placeholder when the environment is complete or plainly local", () => {
    expect(resolveSourceFromEnv({ contentDir: "content", env: {}, onIncomplete: "placeholder" }).kind).toBe("local");
  });
});

/**
 * The most common first-deploy state: someone pushes to Vercel before
 * running `cimisy setup github`, so no cimisy variables exist at all. That
 * resolves to "local", and the local adapter refuses NODE_ENV=production —
 * which used to throw at config import and fail the entire build.
 */
describe("resolveSourceFromEnv with nothing configured, in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("serves the placeholder instead of crashing the build", () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const source = resolveSourceFromEnv({ contentDir: "content", env: {}, onIncomplete: "placeholder" });
      expect(isUnconfiguredSource(source)).toBe(true);
      expect(isUnconfiguredSource(source) && source.missing).toContain("CIMISY_GITHUB_APP_ID");
      expect(String(warn.mock.calls[0]?.[0])).toContain("No content source is configured for production");
    } finally {
      warn.mockRestore();
    }
  });

  it("still refuses outright under the default onIncomplete — the guard rail is unchanged", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => resolveSourceFromEnv({ contentDir: "content", env: {} })).toThrow(/NODE_ENV=production/);
  });

  it("respects an explicit CIMISY_ALLOW_LOCAL_PROD opt-in rather than overriding it", () => {
    vi.stubEnv("NODE_ENV", "production");
    const source = resolveSourceFromEnv({
      contentDir: "content",
      env: { CIMISY_ALLOW_LOCAL_PROD: "true" },
      onIncomplete: "placeholder",
    });
    expect(source.kind).toBe("local");
  });

  it("leaves development alone — local dev with no variables is the normal case", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(resolveSourceFromEnv({ contentDir: "content", env: {}, onIncomplete: "placeholder" }).kind).toBe("local");
  });
});
