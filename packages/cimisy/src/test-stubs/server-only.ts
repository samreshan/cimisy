// Test-only stand-in for the "server-only" package. Next.js's bundler
// enforces the real package's server/client boundary at build time; under
// plain Vitest there's no such bundler, so the real package would just
// throw unconditionally on import. Aliased in via vitest.config.ts.
export {};
