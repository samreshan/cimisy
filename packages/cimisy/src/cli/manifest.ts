/**
 * The GitHub App Manifest `cimisy setup github` POSTs to github.com.
 *
 * A manifest is how GitHub lets a tool declare an App's entire
 * configuration up front — name, URLs, permissions — so the person setting
 * it up confirms one pre-filled page instead of hand-picking permissions
 * and typing callback URLs into a settings form. Pure data assembly, kept
 * separate from the wizard so the exact permission set and callback list
 * are snapshot-testable: getting either wrong is a silent
 * you-find-out-in-production failure.
 *
 * Reference: GitHub Docs → "Registering a GitHub App from a manifest".
 */
import { AUTH_CALLBACK_PATH } from "../shared/auth-callback-path.js";

export { AUTH_CALLBACK_PATH } from "../shared/auth-callback-path.js";

/** GitHub rejects App names longer than this. */
export const MAX_APP_NAME_LENGTH = 34;

export interface GithubAppManifest {
  name: string;
  url: string;
  redirect_url: string;
  callback_urls: string[];
  description: string;
  public: boolean;
  default_events: string[];
  default_permissions: Record<string, string>;
  request_oauth_on_install: boolean;
}

export interface BuildAppManifestOptions {
  /** Globally-unique App name — see suggestAppName. */
  appName: string;
  /** "owner/repo" the App will be installed on; used for the fallback homepage URL. */
  repo: string;
  /** Where the deployed admin lives, e.g. "https://example.vercel.app". Omitted for a localhost-only setup. */
  productionOrigin?: string;
  /** Local dev origin. Defaults to http://localhost:3000. */
  localOrigin?: string;
  /** The wizard's temporary localhost server — where GitHub sends the one-time manifest code. */
  redirectUrl: string;
}

/**
 * `cimisy-<repo-name>`, slugified and clipped to GitHub's limit. Only a
 * suggestion — App names are globally unique across all of GitHub, so the
 * wizard lets the user edit it and GitHub has the final say.
 */
export function suggestAppName(repo: string): string {
  const repoName = repo.includes("/") ? repo.slice(repo.indexOf("/") + 1) : repo;
  const slug = repoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `cimisy-${slug}`.slice(0, MAX_APP_NAME_LENGTH).replace(/-+$/, "");
}

export function buildAppManifest(options: BuildAppManifestOptions): GithubAppManifest {
  const localOrigin = options.localOrigin ?? "http://localhost:3000";

  // Both origins are registered up front. GitHub Apps allow up to 10
  // callback URLs, and registering the localhost one now removes the
  // single most common follow-up support question ("sign-in works in
  // production but not on my machine") — there is no cost to declaring it.
  const callbackUrls = [
    ...(options.productionOrigin ? [`${trimTrailingSlash(options.productionOrigin)}${AUTH_CALLBACK_PATH}`] : []),
    `${trimTrailingSlash(localOrigin)}${AUTH_CALLBACK_PATH}`,
  ];

  return {
    name: options.appName,
    url: options.productionOrigin ? trimTrailingSlash(options.productionOrigin) : `https://github.com/${options.repo}`,
    redirect_url: options.redirectUrl,
    callback_urls: [...new Set(callbackUrls)],
    description: `Content management for ${options.repo}, powered by cimisy.`,
    // Private: installable only on the account that owns it. cimisy is a
    // per-deployment App holding write access to the owner's own repo —
    // there is no scenario where a third party should be able to install it.
    public: false,
    // No webhooks: cimisy consumes no events, and an App with no webhook
    // has no inbound surface to secure. `hook_attributes` is deliberately
    // omitted entirely rather than declared-and-disabled.
    default_events: [],
    default_permissions: {
      // Read/write repo content — the commits the CMS makes.
      contents: "write",
      // Open and merge the draft PRs non-publisher roles produce.
      pull_requests: "write",
      // Resolve an org member's collaborator permission level, which is
      // what cimisy's RBAC maps to a role. (Metadata: read is implicit.)
      members: "read",
    },
    // Makes install and user-identity authorization one step instead of
    // two: the installer comes back already OAuth-authorized.
    request_oauth_on_install: true,
  };
}

/**
 * Where the manifest form POSTs. A personal App is registered under the
 * user's own settings; an org App must be registered under the org's, or
 * it ends up owned by the wrong account and can't be installed on the
 * org's repos.
 */
export function manifestRegistrationUrl(options: { org?: string }): string {
  return options.org
    ? `https://github.com/organizations/${encodeURIComponent(options.org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
