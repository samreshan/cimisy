import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { requireSameOrigin } from "../csrf.js";
import { allowedOrigins, configuredPublicOrigin, resolvePublicOrigin } from "../public-origin.js";

function req(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(new URL(url), { method: "POST", headers });
}

describe("configuredPublicOrigin", () => {
  it("prefers CIMISY_PUBLIC_URL over everything", () => {
    expect(configuredPublicOrigin({ CIMISY_PUBLIC_URL: "https://cms.example.com", VERCEL_PROJECT_PRODUCTION_URL: "ignored.vercel.app" })).toBe(
      "https://cms.example.com",
    );
  });

  it("normalizes to a bare origin, dropping path, query, and trailing slash", () => {
    expect(configuredPublicOrigin({ CIMISY_PUBLIC_URL: "https://cms.example.com/admin?x=1" })).toBe("https://cms.example.com");
    expect(configuredPublicOrigin({ CIMISY_PUBLIC_URL: "https://cms.example.com/" })).toBe("https://cms.example.com");
  });

  it("adds the scheme Vercel omits from VERCEL_PROJECT_PRODUCTION_URL", () => {
    expect(configuredPublicOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "myapp.vercel.app" })).toBe("https://myapp.vercel.app");
  });

  it("uses the *production* Vercel URL, never the per-deployment one — that would reintroduce the preview problem", () => {
    expect(configuredPublicOrigin({ VERCEL_URL: "myapp-git-feat-team.vercel.app" })).toBeNull();
  });

  it("returns null when nothing is configured or the value is unusable", () => {
    expect(configuredPublicOrigin({})).toBeNull();
    expect(configuredPublicOrigin({ CIMISY_PUBLIC_URL: "   " })).toBeNull();
    expect(configuredPublicOrigin({ CIMISY_PUBLIC_URL: "not-a-url" })).toBeNull();
    expect(configuredPublicOrigin({ CIMISY_PUBLIC_URL: "javascript:alert(1)" })).toBeNull();
  });

  it("never consults a request header — X-Forwarded-Host is attacker-controllable and this gates CSRF", () => {
    expect(configuredPublicOrigin({ "x-forwarded-host": "evil.com", HOST: "evil.com" })).toBeNull();
  });
});

describe("resolvePublicOrigin", () => {
  it("falls back to the request origin, preserving the previous behavior", () => {
    expect(resolvePublicOrigin(req("https://preview.vercel.app/api/cimisy/auth/login"), {})).toBe("https://preview.vercel.app");
  });

  it("pins a Vercel preview to the stable production domain, so the redirect_uri is one that's registered", () => {
    expect(
      resolvePublicOrigin(req("https://myapp-git-feat-team.vercel.app/api/cimisy/auth/login"), { VERCEL_PROJECT_PRODUCTION_URL: "myapp.vercel.app" }),
    ).toBe("https://myapp.vercel.app");
  });

  it("survives a Host-rewriting proxy via CIMISY_PUBLIC_URL", () => {
    expect(resolvePublicOrigin(req("http://10.0.0.7:3000/api/cimisy/auth/login"), { CIMISY_PUBLIC_URL: "https://cms.example.com" })).toBe(
      "https://cms.example.com",
    );
  });
});

describe("allowedOrigins", () => {
  it("is just the request origin when nothing is configured", () => {
    expect(allowedOrigins(req("https://app.example.com/x"), {})).toEqual(["https://app.example.com"]);
  });

  it("accepts both the request origin and the configured one, without duplicating them", () => {
    expect(allowedOrigins(req("https://preview.vercel.app/x"), { CIMISY_PUBLIC_URL: "https://app.example.com" })).toEqual([
      "https://preview.vercel.app",
      "https://app.example.com",
    ]);
    expect(allowedOrigins(req("https://app.example.com/x"), { CIMISY_PUBLIC_URL: "https://app.example.com" })).toEqual(["https://app.example.com"]);
  });
});

describe("requireSameOrigin still fails closed", () => {
  it("accepts a matching Origin and rejects a foreign one", () => {
    expect(() => requireSameOrigin(req("https://app.example.com/api", { origin: "https://app.example.com" }))).not.toThrow();
    expect(() => requireSameOrigin(req("https://app.example.com/api", { origin: "https://evil.com" }))).toThrow(/Cross-origin/);
  });

  it("rejects a request with neither Origin nor Referer", () => {
    expect(() => requireSameOrigin(req("https://app.example.com/api"))).toThrow(/no Origin or Referer/);
  });

  it("falls back to Referer", () => {
    expect(() => requireSameOrigin(req("https://app.example.com/api", { referer: "https://app.example.com/admin" }))).not.toThrow();
    expect(() => requireSameOrigin(req("https://app.example.com/api", { referer: "https://evil.com/x" }))).toThrow(/Cross-origin/);
  });

  it("does not let a spoofed forwarding header widen the accepted set", () => {
    expect(() =>
      requireSameOrigin(
        req("https://app.example.com/api", { origin: "https://evil.com", "x-forwarded-host": "evil.com", host: "evil.com" }),
      ),
    ).toThrow(/Cross-origin/);
  });
});
