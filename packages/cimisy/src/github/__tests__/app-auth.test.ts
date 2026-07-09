import { describe, expect, it } from "vitest";
import { normalizePrivateKey } from "../app-auth.js";

describe("normalizePrivateKey", () => {
  it("converts literal \\n escapes to real newlines when no real newline is present", () => {
    const escaped = "-----BEGIN RSA PRIVATE KEY-----\\nABC123\\n-----END RSA PRIVATE KEY-----\\n";
    expect(normalizePrivateKey(escaped)).toBe(
      "-----BEGIN RSA PRIVATE KEY-----\nABC123\n-----END RSA PRIVATE KEY-----\n",
    );
  });

  it("leaves an already-multiline key untouched", () => {
    const real = "-----BEGIN RSA PRIVATE KEY-----\nABC123\n-----END RSA PRIVATE KEY-----\n";
    expect(normalizePrivateKey(real)).toBe(real);
  });
});
