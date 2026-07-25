import { describe, expect, it } from "vitest";
import { generateSessionSecret, isValidProductionOrigin } from "../setup-github.js";

describe("generateSessionSecret", () => {
  it("is long enough for the adapter's own >=32-character floor, and never repeats", () => {
    const secret = generateSessionSecret();
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(secret).not.toBe(generateSessionSecret());
  });
});

describe("isValidProductionOrigin", () => {
  it("accepts https origins", () => {
    expect(isValidProductionOrigin("https://example.vercel.app")).toBe(true);
    expect(isValidProductionOrigin("https://cms.example.com/")).toBe(true);
  });

  it("refuses non-TLS and malformed origins — the session cookie is Secure, so http could never sign in", () => {
    expect(isValidProductionOrigin("http://example.com")).toBe(false);
    expect(isValidProductionOrigin("example.com")).toBe(false);
    expect(isValidProductionOrigin("")).toBe(false);
    expect(isValidProductionOrigin("javascript:alert(1)")).toBe(false);
  });
});
