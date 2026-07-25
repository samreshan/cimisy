import { githubSource } from "../adapters/github/adapter.js";
import { CimisyError } from "../shared/errors.js";
import { missingGithubEnvMessage, REQUIRED_GITHUB_ENV_VARS, unconfiguredProductionMessage } from "../shared/github-env.js";
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

/**
 * Read from the injected env record rather than `process.env` directly, so
 * a test can exercise the production path without mutating the real
 * environment. Falls back to `process.env.NODE_ENV` because that's what
 * the local adapter itself checks, and the two must agree.
 */
function isProductionEnv(env: EnvRecord): boolean {
  return (env.NODE_ENV ?? process.env.NODE_ENV) === "production";
}

export function resolveSourceFromEnv(options: ResolveSourceFromEnvOptions): StorageAdapter {
  const env = options.env ?? process.env;
  const resolution = readSourceEnv(env);

  for (const warning of resolution.warnings) console.warn(`[cimisy] ${warning}`);

  if (resolution.mode === "local") {
    // The single most common first-deploy state: someone pushes to a
    // hosting platform before running `cimisy setup github`, so *no*
    // cimisy variables are set at all. That resolves to "local", and the
    // local adapter rightly refuses to run in production (no auth, direct
    // disk writes) — but it does so by throwing at config import, which
    // fails the whole build with a stack trace naming nothing actionable.
    //
    // Under "placeholder" that becomes the unconfigured source instead:
    // the guard rail is untouched (the local adapter still never runs in
    // production), but the deploy builds and /admin explains what to set.
    // Note this is keyed on the *adapter's* own refusal condition, so it
    // stays in step with storage/local.ts rather than second-guessing it.
    if (options.onIncomplete === "placeholder" && isProductionEnv(env) && !resolution.allowInProduction) {
      console.warn(`[cimisy] ${unconfiguredProductionMessage()}`);
      return unconfiguredSource({ missing: REQUIRED_GITHUB_ENV_VARS });
    }
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
