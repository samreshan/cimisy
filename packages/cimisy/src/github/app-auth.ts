import "server-only";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { CimisyError } from "../shared/errors.js";

export interface GithubAppCredentials {
  appId: string;
  /** PEM-encoded App private key. */
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

/**
 * PEM keys are multi-line, and env files/dashboards routinely mangle real
 * newlines — the common workaround is storing the key with literal `\n`
 * escape sequences instead. Only rewrite those to real newlines when the
 * string has no actual newline already, so a correctly-stored multi-line
 * key (e.g. from a `.env` file that preserves it, or a secrets manager) is
 * never touched.
 */
export function normalizePrivateKey(privateKey: string): string {
  if (privateKey.includes("\n")) return privateKey;
  return privateKey.replace(/\\n/g, "\n");
}

/**
 * JWT construction (App-level) and installation-token exchange are
 * deliberately delegated to @octokit/auth-app rather than hand-rolled here
 * — RS256 JWT signing and token-exchange retry/refresh logic is exactly
 * the kind of security-critical code that's safer to reuse from a
 * well-audited, widely-used library than to reimplement.
 *
 * Note: @octokit/auth-app's "installation" strategy requires a numeric
 * installationId up front — it does NOT resolve one from a repo owner/name
 * itself (despite `repositoryNames`/`repositoryOwner`-shaped options
 * appearing elsewhere in its types, those only *scope* an already-resolved
 * installation's token permissions, they don't look the installation up).
 * So this class does the lookup itself via an App-level JWT first.
 */
export class GithubAppAuth {
  private readonly appAuth: ReturnType<typeof createAppAuth>;
  // Installation IDs are stable metadata (they only change if the App is
  // uninstalled/reinstalled), unlike tokens — safe to cache per adapter
  // instance to avoid an extra round trip on every read/write.
  private readonly installationIdCache = new Map<string, number>();

  constructor(private readonly credentials: GithubAppCredentials) {
    this.appAuth = createAppAuth({
      appId: credentials.appId,
      privateKey: normalizePrivateKey(credentials.privateKey),
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
  }

  private async resolveInstallationId(owner: string, repo: string): Promise<number> {
    const cacheKey = `${owner}/${repo}`;
    const cached = this.installationIdCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const appJwt = await this.appAuth({ type: "app" });
    const appClient = new Octokit({ auth: appJwt.token });
    const { data } = await appClient.rest.apps.getRepoInstallation({ owner, repo });
    this.installationIdCache.set(cacheKey, data.id);
    return data.id;
  }

  /**
   * Returns an Octokit client authenticated with a fresh installation
   * access token scoped to the given repo. The token itself is never
   * cached/reused across calls by design (see the plan's serverless
   * token-flow notes): a serverless function is stateless per-invocation
   * anyway, installation tokens are cheap to mint, and always fetching
   * fresh avoids ever serving an expired/soon-to-expire token.
   */
  async getInstallationClient(owner: string, repo: string): Promise<Octokit> {
    try {
      const installationId = await this.resolveInstallationId(owner, repo);
      const auth = await this.appAuth({ type: "installation", installationId });
      return new Octokit({ auth: auth.token });
    } catch {
      throw new CimisyError(
        `Could not obtain a GitHub App installation token for ${owner}/${repo}. ` +
          "Is the GitHub App installed on this repository?",
        "GITHUB_APP_NOT_INSTALLED",
      );
    }
  }

  get oauthClientId(): string {
    return this.credentials.clientId;
  }

  get oauthClientSecret(): string {
    return this.credentials.clientSecret;
  }
}
