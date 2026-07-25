import { githubSource } from "../adapters/github/adapter.js";
import { CimisyError } from "../shared/errors.js";
import { missingGithubEnvMessage } from "../shared/github-env.js";
import { localSource } from "../storage/local.js";
import type { StorageAdapter } from "../storage/types.js";
import { unconfiguredSource } from "../storage/unconfigured.js";
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
  /**
   * What to do when the GitHub source is selected but some of its
   * variables are missing.
   *
   * `"throw"` (default) preserves the historical fail-fast behavior: the
   * config file throws at import, which in Next.js fails the build.
   *
   * `"placeholder"` returns an `unconfigured` source instead — the app
   * builds, the API answers 503 naming the missing variables, and `/admin`
   * renders instructions. This is what `cimisy setup` scaffolds, because
   * the person who hits this state is usually mid-deploy and needs to be
   * told what's missing, not handed a stack trace.
   *
   * A *malformed* `CIMISY_CONFIG` throws under either setting — corrupt is
   * not the same as incomplete, and silently degrading it would hide a
   * config that someone believes is set.
   */
  onIncomplete?: "throw" | "placeholder";
}

export function resolveSourceFromEnv(options: ResolveSourceFromEnvOptions): StorageAdapter {
  const env = options.env ?? process.env;
  const resolution = readSourceEnv(env);

  for (const warning of resolution.warnings) console.warn(`[cimisy] ${warning}`);

  if (resolution.mode === "local") {
    return localSource({ rootDir: options.contentDir, allowInProduction: resolution.allowInProduction });
  }

  if (!resolution.options) {
    if (options.onIncomplete === "placeholder") {
      console.warn(`[cimisy] ${missingGithubEnvMessage(resolution.missing)}`);
      return unconfiguredSource({ missing: resolution.missing });
    }
    throw new CimisyError(missingGithubEnvMessage(resolution.missing), "MISSING_GITHUB_CONFIG");
  }

  return githubSource(resolution.options);
}
