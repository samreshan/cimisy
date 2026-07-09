import { describe, expect, it, vi } from "vitest";
import { clientIpFromRequest, createInMemoryRateLimiter, createNoopRateLimiter } from "../rate-limit.js";

describe("createInMemoryRateLimiter", () => {
  it("allows requests up to the limit within a window", async () => {
    const limiter = createInMemoryRateLimiter({ limit: 3, windowMs: 10_000 });
    expect((await limiter.consume("k")).allowed).toBe(true);
    expect((await limiter.consume("k")).allowed).toBe(true);
    expect((await limiter.consume("k")).allowed).toBe(true);
  });

  it("rejects requests beyond the limit within the same window", async () => {
    const limiter = createInMemoryRateLimiter({ limit: 2, windowMs: 10_000 });
    await limiter.consume("k");
    await limiter.consume("k");
    const result = await limiter.consume("k");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks separate keys independently", async () => {
    const limiter = createInMemoryRateLimiter({ limit: 1, windowMs: 10_000 });
    expect((await limiter.consume("a")).allowed).toBe(true);
    expect((await limiter.consume("b")).allowed).toBe(true); // different key, its own budget
    expect((await limiter.consume("a")).allowed).toBe(false); // "a" is now exhausted
  });

  it("resets after the window elapses", async () => {
    vi.useFakeTimers();
    try {
      const limiter = createInMemoryRateLimiter({ limit: 1, windowMs: 1000 });
      expect((await limiter.consume("k")).allowed).toBe(true);
      expect((await limiter.consume("k")).allowed).toBe(false);
      vi.advanceTimersByTime(1001);
      expect((await limiter.consume("k")).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createNoopRateLimiter", () => {
  it("never rejects", async () => {
    const limiter = createNoopRateLimiter();
    for (let i = 0; i < 100; i++) {
      expect((await limiter.consume("k")).allowed).toBe(true);
    }
  });
});

describe("clientIpFromRequest", () => {
  it("prefers the first entry of x-forwarded-for", () => {
    const request = { headers: { get: (name: string) => (name === "x-forwarded-for" ? "1.2.3.4, 5.6.7.8" : null) } };
    expect(clientIpFromRequest(request)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const request = { headers: { get: (name: string) => (name === "x-real-ip" ? "9.9.9.9" : null) } };
    expect(clientIpFromRequest(request)).toBe("9.9.9.9");
  });

  it("falls back to \"unknown\" when neither header is present", () => {
    const request = { headers: { get: () => null } };
    expect(clientIpFromRequest(request)).toBe("unknown");
  });
});
