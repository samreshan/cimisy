import { githubSource } from "../adapters/github/adapter.js";
import { CimisyError } from "../shared/errors.js";
import { missingGithubEnvMessage } from "../shared/github-env.js";
import { localSource } from "../storage/local.js";
import type { StorageAdapter } from "../storage/types.js";
import { readSourceEnv, type EnvRecord } from "./read-env.js";

/**
 * One call that replaces the hand-written `resolveSource()` switch every
 * cimisy consumer used to paste into their `cimisy.config.ts` — local
 * adapter in dev, GitHub adapter in production, wired from env vars. Those
 * hand-written switches drifted (different var names per project, each
 * with its own missing-var failure mode), which is precisely what this
 * exists to stop.
 *
 * This module may import *both* adapters, unlike shared/github-source-
 * shape.ts's careful avoidance of the concrete GitHub adapter: that
 * constraint exists so local-only consumers of `cimisy/next` don't drag
 * octokit into their bundle, and importing `cimisy/env` at all is itself
 * the opt-in to env-driven resolution. It's only ever reached from a
 * consumer's config file, server-side.
 */
export interface ResolveSourceFromEnvOptions {
  /** Directory local-adapter content is read from/written to, e.g. "content". Ignored in GitHub mode. */
  contentDir: string;
  /** Defaults to `process.env`. Injectable so tests never mutate the real environment. */
  env?: EnvRecord;
}

export function resolveSourceFromEnv(options: ResolveSourceFromEnvOptions): StorageAdapter {
  const env = options.env ?? process.env;
  const resolution = readSourceEnv(env);

  for (const warning of resolution.warnings) console.warn(`[cimisy] ${warning}`);

  if (resolution.mode === "local") {
    return localSource({ rootDir: options.contentDir, allowInProduction: resolution.allowInProduction });
  }

  if (!resolution.options) {
    throw new CimisyError(missingGithubEnvMessage(resolution.missing), "MISSING_GITHUB_CONFIG");
  }

  return githubSource(resolution.options);
}
