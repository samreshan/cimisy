import {
  CIMISY_ENV_VARS,
  GITHUB_CREDENTIAL_ENV_VARS,
  REQUIRED_GITHUB_ENV_VARS,
  type GithubCredentialKey,
} from "../shared/github-env.js";
import { normalizePrivateKey } from "../shared/private-key.js";
import { decodeCimisyConfigBlob } from "./blob.js";

/**
 * The pure half of env-driven source resolution: reads an environment
 * record and reports *what it found* without constructing any adapter.
 *
 * Split from resolve-source.ts so `cimisy doctor` can report the same
 * answer from plain Node — resolve-source.ts imports the GitHub adapter,
 * which is `import "server-only"` and throws outside a React Server
 * Components bundler. Both surfaces therefore agree on precedence,
 * required-var lists, and PEM handling by construction rather than by two
 * implementations happening to match.
 */

export type EnvRecord = Record<string, string | undefined>;

/** Exactly the options `githubSource()` needs, assembled from env. */
export interface GithubSourceEnvOptions {
  repo: string;
  branch: string;
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
}

export interface GithubEnvResolution {
  mode: "github";
  /** Which form the values came from — the single `CIMISY_CONFIG` blob or the individual vars. */
  origin: "blob" | "vars";
  /** Canonical env var names that are required but absent/blank. Empty when `options` is present. */
  missing: string[];
  /** Present iff `missing` is empty. */
  options?: GithubSourceEnvOptions;
  warnings: string[];
}

export interface LocalEnvResolution {
  mode: "local";
  allowInProduction: boolean;
  warnings: string[];
}

export type EnvResolution = GithubEnvResolution | LocalEnvResolution;

/** Treat a whitespace-only value as unset — a dashboard field someone cleared by hitting space is "missing", not "set to nothing". */
function value(env: EnvRecord, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * `\n`-unescape, then trim. The trim matters for consistency: a PEM stored
 * as a real multi-line value ends with a newline, one stored `\n`-escaped
 * usually doesn't, and without this the *same key* would resolve to two
 * different strings depending on which form it was pasted in. Surrounding
 * whitespace is not part of a PEM's meaning, so normalizing it away here
 * makes "did the key change?" answerable.
 */
function readPrivateKey(raw: string): string {
  return normalizePrivateKey(raw).trim();
}

/**
 * Precedence, deliberately all-or-nothing: `CIMISY_CONFIG` wins outright
 * when set — individual vars never merge into or override blob fields.
 * A half-blob/half-vars config would make "which value is actually live?"
 * a question nobody could answer from a dashboard screenshot, and this is
 * the exact surface where a stale leftover var causes a silent
 * wrong-repo/wrong-key deploy. When both forms are present the blob wins
 * and a warning says so.
 */
export function readSourceEnv(env: EnvRecord): EnvResolution {
  const warnings: string[] = [];
  const blob = value(env, CIMISY_ENV_VARS.config);
  const sourceSwitch = value(env, CIMISY_ENV_VARS.source);

  if (!blob && sourceSwitch !== "github") {
    return {
      mode: "local",
      allowInProduction: value(env, CIMISY_ENV_VARS.allowLocalProd) === "true",
      warnings,
    };
  }

  if (blob) {
    const shadowed = REQUIRED_GITHUB_ENV_VARS.filter((name) => value(env, name) !== undefined);
    if (shadowed.length > 0) {
      warnings.push(
        `${CIMISY_ENV_VARS.config} is set, so it takes precedence — ${shadowed.join(", ")} ${shadowed.length === 1 ? "is" : "are"} ignored. ` +
          `Unset the individual vars to avoid confusion (cimisy never merges the two forms).`,
      );
    }
    // Throws (INVALID_CONFIG_BLOB / UNSUPPORTED_CONFIG_BLOB_VERSION) on a
    // malformed blob — that's a corrupt config, not an incomplete one, so
    // it must not be softened into a "missing vars" placeholder.
    const decoded = decodeCimisyConfigBlob(blob);
    return {
      mode: "github",
      origin: "blob",
      missing: [],
      options: {
        repo: decoded.repo,
        branch: decoded.branch ?? "main",
        appId: decoded.appId,
        privateKey: readPrivateKey(decoded.privateKey),
        clientId: decoded.clientId,
        clientSecret: decoded.clientSecret,
        sessionSecret: decoded.sessionSecret,
      },
      warnings,
    };
  }

  const repo = value(env, CIMISY_ENV_VARS.repo);
  const sessionSecret = value(env, CIMISY_ENV_VARS.sessionSecret);
  const credentials = Object.fromEntries(
    (Object.keys(GITHUB_CREDENTIAL_ENV_VARS) as GithubCredentialKey[]).map((key) => [key, value(env, GITHUB_CREDENTIAL_ENV_VARS[key])]),
  ) as Record<GithubCredentialKey, string | undefined>;

  const missing = REQUIRED_GITHUB_ENV_VARS.filter((name) => value(env, name) === undefined);
  if (missing.length > 0) {
    return { mode: "github", origin: "vars", missing: [...missing], warnings };
  }

  return {
    mode: "github",
    origin: "vars",
    missing: [],
    options: {
      repo: repo!,
      branch: value(env, CIMISY_ENV_VARS.branch) ?? "main",
      appId: credentials.appId!,
      // The adapter normalizes this too; doing it here as well means
      // doctor and the wizard see the same PEM the runtime will.
      privateKey: readPrivateKey(credentials.privateKey!),
      clientId: credentials.clientId!,
      clientSecret: credentials.clientSecret!,
      sessionSecret: sessionSecret!,
    },
    warnings,
  };
}
