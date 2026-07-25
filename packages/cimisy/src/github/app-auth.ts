import "server-only";

/**
 * The server-only face of the App auth code. The implementation lives in
 * app-auth-core.ts so `cimisy setup github` / `cimisy doctor` can reuse
 * the very same JWT + installation-token path from plain Node (the real
 * "server-only" package throws on import outside an RSC bundler) — see
 * that file's header for why the marker still holds where it matters.
 */
export { GithubAppAuth } from "./app-auth-core.js";
export type { AppMetadata, GithubAppCredentials, RepoInstallation } from "./app-auth-core.js";
export { normalizePrivateKey } from "../shared/private-key.js";
