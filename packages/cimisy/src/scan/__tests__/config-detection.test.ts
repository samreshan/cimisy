import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectSource, resolveConfigFilePath } from "../config-detection.js";

describe("resolveConfigFilePath", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-config-detection-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds an existing hand-authored cimisy.config.js instead of assuming .ts", async () => {
    const jsConfig = path.join(root, "cimisy.config.js");
    await writeFile(jsConfig, "module.exports = {};\n");
    expect(await resolveConfigFilePath(root)).toBe(jsConfig);
  });

  it("finds an existing cimisy.config.mjs", async () => {
    const mjsConfig = path.join(root, "cimisy.config.mjs");
    await writeFile(mjsConfig, "export default {};\n");
    expect(await resolveConfigFilePath(root)).toBe(mjsConfig);
  });

  it("prefers .ts over .js when both somehow exist (matches the README quickstart default)", async () => {
    const tsConfig = path.join(root, "cimisy.config.ts");
    await writeFile(tsConfig, "export default {};\n");
    await writeFile(path.join(root, "cimisy.config.js"), "module.exports = {};\n");
    expect(await resolveConfigFilePath(root)).toBe(tsConfig);
  });

  it("falls back to the conventional cimisy.config.ts path when no config file exists yet", async () => {
    expect(await resolveConfigFilePath(root)).toBe(path.join(root, "cimisy.config.ts"));
  });
});

describe("detectSource", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("still detects localSource in a plain .js config (detectSource itself was never extension-specific)", () => {
    const configText = `
      module.exports = {
        source: localSource({ rootDir: "./content" }),
        collections: {},
      };
    `;
    expect(detectSource(configText, "/project/cimisy.config.js")).toEqual({ kind: "local", rootDir: "./content" });
  });

  describe("the README's NODE_ENV-based local/github switch", () => {
    const configText = `
      const source =
        process.env.NODE_ENV === "development"
          ? localSource({ rootDir: "." })
          : githubSource({ owner: "x", repo: "y" });
      module.exports = { source };
    `;

    it("resolves to local when NODE_ENV is development, even though githubSource is textually last", () => {
      vi.stubEnv("NODE_ENV", "development");
      expect(detectSource(configText, "/project/cimisy.config.js")).toEqual({ kind: "local", rootDir: "." });
    });

    it("resolves to github when NODE_ENV is production", () => {
      vi.stubEnv("NODE_ENV", "production");
      expect(detectSource(configText, "/project/cimisy.config.js")).toEqual({ kind: "github" });
    });

    it("resolves to github when NODE_ENV is unset (matches the else branch)", () => {
      vi.stubEnv("NODE_ENV", undefined);
      expect(detectSource(configText, "/project/cimisy.config.js")).toEqual({ kind: "github" });
    });

    it("handles the reversed operand order and !== negation", () => {
      const reversed = `
        const source =
          "production" !== process.env.NODE_ENV
            ? localSource({ rootDir: "." })
            : githubSource({ owner: "x", repo: "y" });
      `;
      vi.stubEnv("NODE_ENV", "development");
      expect(detectSource(reversed, "/project/cimisy.config.js")).toEqual({ kind: "local", rootDir: "." });
      vi.stubEnv("NODE_ENV", "production");
      expect(detectSource(reversed, "/project/cimisy.config.js")).toEqual({ kind: "github" });
    });
  });

  it("refuses to guess a conditional keyed on anything other than NODE_ENV, rather than picking whichever branch is textually last", () => {
    const configText = `
      const source = someOtherFlag ? localSource({ rootDir: "." }) : githubSource({ owner: "x", repo: "y" });
    `;
    expect(detectSource(configText, "/project/cimisy.config.js")).toEqual({ kind: "unknown" });
  });
});
