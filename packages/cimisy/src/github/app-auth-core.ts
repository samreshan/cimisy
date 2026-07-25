import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { CimisyError } from "../shared/errors.js";
import { normalizePrivateKey } from "../shared/private-key.js";

/**
 * The implementation half of app-auth.ts, split out so the CLI can reuse
 * it. `app-auth.ts` is `import "server-only"` (it's on the request path,
 * where a client-component import must be a build error) — but that
 * package throws unconditionally outside a React Server Components
 * bundler, so `cimisy setup github` / `cimisy doctor` could not import it
 * from plain Node. Rather than hand-roll a second JWT/installation-token
 * path for the CLI (exactly the code the threat model says not to
 * duplicate), the code lives here and app-auth.ts re-exports it behind the
 * server-only marker. Nothing in package.json's "exports" map points at
 * this file; the runtime entry points a client component could reach
 * (cimisy/adapters/github, cimisy/next) all still go through a
 * server-only module.
 */

export interface GithubAppCredentials {
  appId: string;
  /** PEM-encoded App private key. */
  privateKey: string;
  clientId: string;
  clientSecret: string;
}

/** Subset of GitHub's repo-installation record cimisy actually uses. */
export interface RepoInstallation {
  id: number;
  /** Permissions actually granted to the installation, e.g. `{ contents: "write", pull_requests: "write" }`. */
  permissions: Record<string, string>;
  /** Who the App is installed on — a user for a personal repo, an organization otherwise. */
  account: { login: string; type: string } | null;
}

/** Subset of GitHub's App record — enough for `cimisy doctor` to prove the App JWT was accepted. */
export interface AppMetadata {
  id: number;
  slug: string | null;
  name: string;
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

  /** An Octokit authenticated as the App itself (JWT), for the two App-level lookups below. */
  private async getAppClient(): Promise<Octokit> {
    const appJwt = await this.appAuth({ type: "app" });
    return new Octokit({ auth: appJwt.token });
  }

  /**
   * Proves the appId + private key pair is valid by minting an App JWT and
   * calling `GET /app` with it. Deliberately returns the App's public
   * metadata rather than the JWT itself — callers only ever need "did this
   * work", and handing out a signed credential would be a needless way to
   * leak one. Used by `cimisy doctor`.
   */
  async getAppMetadata(): Promise<AppMetadata> {
    const appClient = await this.getAppClient();
    const { data } = await appClient.rest.apps.getAuthenticated();
    // The REST type allows a null body for the JWT-authenticated variant.
    if (!data) throw new CimisyError("GitHub returned no App metadata for this App JWT.", "GITHUB_APP_AUTH_FAILED");
    return { id: data.id, slug: data.slug ?? null, name: data.name };
  }

  /**
   * Looks the App's installation on a repo up, returning the granted
   * permissions alongside the id. Unlike getInstallationClient this does
   * NOT collapse every failure into "not installed" — the wizard's install
   * polling and doctor both need to tell "no installation yet" (404) apart
   * from "these credentials are wrong" (401), so the original error is
   * left to the caller to classify.
   */
  async getRepoInstallation(owner: string, repo: string): Promise<RepoInstallation> {
    const appClient = await this.getAppClient();
    const { data } = await appClient.rest.apps.getRepoInstallation({ owner, repo });
    this.installationIdCache.set(`${owner}/${repo}`, data.id);
    // `account` is a union of several actor shapes (and nullable) in the
    // REST types; only login/type are ever read, and both are optional
    // across that union.
    const account = data.account as { login?: string; type?: string } | null | undefined;
    return {
      id: data.id,
      permissions: (data.permissions ?? {}) as Record<string, string>,
      account: account?.login ? { login: account.login, type: account.type ?? "" } : null,
    };
  }

  private async resolveInstallationId(owner: string, repo: string): Promise<number> {
    const cacheKey = `${owner}/${repo}`;
    const cached = this.installationIdCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const installation = await this.getRepoInstallation(owner, repo);
    return installation.id;
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
