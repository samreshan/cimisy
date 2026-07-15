import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  it("still detects localSource in a plain .js config (detectSource itself was never extension-specific)", () => {
    const configText = `
      module.exports = {
        source: localSource({ rootDir: "./content" }),
        collections: {},
      };
    `;
    expect(detectSource(configText, "/project/cimisy.config.js")).toEqual({ kind: "local", rootDir: "./content" });
  });
});
