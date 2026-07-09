import "server-only";

export interface RateLimitResult {
  allowed: boolean;
  /** Present when `allowed` is false — how long the caller should wait before retrying. */
  retryAfterMs?: number;
}

/**
 * The extension point for rate limiting, not a production-grade rate
 * limiter — cimisy ships as a package installed into someone else's app,
 * not a hosted service with its own persistent infra, so it can't assume
 * Redis/Vercel KV/etc. are available. Implement this interface against
 * whatever your deployment already has (Upstash Redis, Vercel KV, a
 * database) and pass it via GithubSourceOptions/route-handler options;
 * createInMemoryRateLimiter below is the default and is explicitly *not*
 * safe for a multi-instance serverless deployment (see its own doc
 * comment) — it's there so rate limiting has sane out-of-the-box behavior
 * for local dev and single-instance deployments, not as a scalability
 * promise.
 */
export interface RateLimiter {
  consume(key: string): Promise<RateLimitResult>;
}

export interface InMemoryRateLimiterOptions {
  /** Max requests allowed per key within the window. */
  limit: number;
  windowMs: number;
}

/**
 * A simple fixed-window counter, held in a plain Map. Explicitly NOT
 * reliable across multiple serverless function instances (each cold
 * start gets its own empty Map, so an attacker distributing requests
 * across instances trivially bypasses this) — it's a reasonable default
 * for local dev and small always-on deployments, and it defines the
 * interface boundary for anyone who needs the real thing in production.
 */
export function createInMemoryRateLimiter(options: InMemoryRateLimiterOptions): RateLimiter {
  const counters = new Map<string, { count: number; windowStart: number }>();

  return {
    async consume(key: string): Promise<RateLimitResult> {
      const now = Date.now();
      const entry = counters.get(key);
      if (!entry || now - entry.windowStart >= options.windowMs) {
        counters.set(key, { count: 1, windowStart: now });
        return { allowed: true };
      }
      if (entry.count >= options.limit) {
        return { allowed: false, retryAfterMs: options.windowMs - (now - entry.windowStart) };
      }
      entry.count += 1;
      return { allowed: true };
    },
  };
}

/** Never limits — the default when no RateLimiter is configured, so rate limiting is opt-in, not a surprise behavior change. */
export function createNoopRateLimiter(): RateLimiter {
  return { consume: async () => ({ allowed: true }) };
}

/** Best-effort client identifier for keying rate limits by IP. Trusts `x-forwarded-for` only because that's what a real front-line proxy (Vercel, most CDNs) sets — a self-hosted deployment without a trusted proxy in front should not rely on this alone. */
export function clientIpFromRequest(request: { headers: { get(name: string): string | null } }): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() ?? "unknown";
  return request.headers.get("x-real-ip") ?? "unknown";
}
