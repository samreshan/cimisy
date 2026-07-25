/**
 * The canonical environment-variable names for cimisy's GitHub source, in
 * exactly one place. Before v2.5 these names only existed as string
 * literals inside the adapter's error messages, which is how consumers
 * ended up inventing their own (`CIMISY_GH_APP_ID` and friends) — the
 * error text was the only spec. Everything that names an env var now
 * reads it from here: the adapter's missing-credential errors, the
 * env-driven resolver (`cimisy/env`), `cimisy setup github`, and
 * `cimisy doctor`.
 *
 * Deliberately dependency-free (no `server-only`, no adapters) so the CLI
 * can import it in plain Node.
 */

/** GitHub App credential fields → the env var each is conventionally wired from. */
export const GITHUB_CREDENTIAL_ENV_VARS = {
  appId: "CIMISY_GITHUB_APP_ID",
  privateKey: "CIMISY_GITHUB_APP_PRIVATE_KEY",
  clientId: "CIMISY_GITHUB_APP_CLIENT_ID",
  clientSecret: "CIMISY_GITHUB_APP_CLIENT_SECRET",
} as const;

export type GithubCredentialKey = keyof typeof GITHUB_CREDENTIAL_ENV_VARS;

/** Every env var cimisy itself reads for source resolution. */
export const CIMISY_ENV_VARS = {
  /** Opt-in switch: "github" selects the GitHub source; anything else (or unset) means local. */
  source: "CIMISY_SOURCE",
  /** The one-paste alternative — base64url JSON carrying every field below. See env/blob.ts. */
  config: "CIMISY_CONFIG",
  repo: "CIMISY_GITHUB_REPO",
  branch: "CIMISY_GITHUB_BRANCH",
  sessionSecret: "CIMISY_SESSION_SECRET",
  allowLocalProd: "CIMISY_ALLOW_LOCAL_PROD",
  ...GITHUB_CREDENTIAL_ENV_VARS,
} as const;

/** Required for a working GitHub source, in the order they're reported. `branch` is optional (defaults to "main"). */
export const REQUIRED_GITHUB_ENV_VARS = [
  CIMISY_ENV_VARS.repo,
  CIMISY_ENV_VARS.appId,
  CIMISY_ENV_VARS.privateKey,
  CIMISY_ENV_VARS.clientId,
  CIMISY_ENV_VARS.clientSecret,
  CIMISY_ENV_VARS.sessionSecret,
] as const;

/**
 * The adapter's own "you passed githubSource() an incomplete options
 * object" message — phrased around the option keys, since an explicit
 * `githubSource({...})` caller may not be wiring env vars at all.
 */
export function missingGithubCredentialsMessage(missing: GithubCredentialKey[]): string {
  return (
    `githubSource is missing credentials: ${missing.join(", ")}. ` +
    `If you wire these from env vars, make sure ${missing.map((k) => GITHUB_CREDENTIAL_ENV_VARS[k]).join(", ")} ` +
    `${missing.length === 1 ? "is" : "are"} set (e.g. in .env.local) — see the README's GitHub App setup walkthrough.`
  );
}

/**
 * The env-driven resolver's counterpart: the caller never named an option,
 * so this one names env vars directly and points at the wizard that writes
 * them.
 */
export function missingGithubEnvMessage(missing: readonly string[]): string {
  return (
    `cimisy is configured for the GitHub source but ${missing.length === 1 ? "this environment variable is" : "these environment variables are"} missing: ` +
    `${missing.join(", ")}. Run "npx cimisy setup github" to register the GitHub App and write them for you, ` +
    `or set ${CIMISY_ENV_VARS.config} to the single-variable blob that wizard prints. Run "npx cimisy doctor" to re-check.`
  );
}
