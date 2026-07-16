import { describe, expect, it, vi } from "vitest";
import { CliUsageError, parseModeFlag, resolveMode } from "../index.js";

describe("parseModeFlag", () => {
  it("accepts --mode=value and --mode value", () => {
    expect(parseModeFlag(["--mode=static"])).toBe("static");
    expect(parseModeFlag(["--mode", "collections-metadata"])).toBe("collections-metadata");
    expect(parseModeFlag([])).toBeUndefined();
  });

  it("throws a usage error on an unknown mode", () => {
    expect(() => parseModeFlag(["--mode=everything"])).toThrow(CliUsageError);
    expect(() => parseModeFlag(["--mode"])).toThrow(CliUsageError);
  });
});

describe("resolveMode precedence", () => {
  it("--mode beats config, config beats default", () => {
    expect(resolveMode(["--mode=static"], { mode: "collections-metadata" })).toBe("static");
    expect(resolveMode([], { mode: "collections-metadata" })).toBe("collections-metadata");
    expect(resolveMode([], {})).toBe("collections");
  });

  it("--full maps to static-metadata with a deprecation notice, and conflicts with --mode", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveMode(["--full"], {})).toBe("static-metadata");
      expect(consoleError).toHaveBeenCalledOnce();
      expect(() => resolveMode(["--full", "--mode=static"], {})).toThrow(CliUsageError);
    } finally {
      consoleError.mockRestore();
    }
  });
});
