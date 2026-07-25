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

/**
 * Public suffixes that are two labels rather than one, so that
 * `samreshan.com.np` reads as an apex domain and not as a subdomain of
 * `com.np`. A regex over the common second-level patterns rather than the
 * full Public Suffix List: this only decides whether to offer a `www.`
 * sibling, and the cost of a miss is one unused callback URL, not a
 * security boundary.
 */
const MULTI_LABEL_PUBLIC_SUFFIX = /^(?:com|co|net|org|edu|gov|ac|or|ne|gob|mil|govt|sch|res|web|info)\.[a-z]{2}$/;

/**
 * Multi-tenant hosting domains, where `www.<project>` is a different site
 * (or nobody's site) rather than the same one. Never pair across these.
 */
const PLATFORM_SUFFIXES = [
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "onrender.com",
  "fly.dev",
  "github.io",
  "herokuapp.com",
  "deno.dev",
  "railway.app",
  "azurewebsites.net",
  "appspot.com",
  "surge.sh",
];

function isPlatformHost(host: string): boolean {
  return PLATFORM_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** True when `host` is the registrable domain itself — `example.com`, `samreshan.com.np` — and not a subdomain of one. */
function isApexHost(host: string): boolean {
  if (host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  const suffixLabels = MULTI_LABEL_PUBLIC_SUFFIX.test(labels.slice(-2).join(".")) ? 2 : 1;
  return labels.length === suffixLabels + 1;
}

/**
 * The origin as given, plus its apex/`www.` sibling when there is one.
 *
 * GitHub Apps match `redirect_uri` byte-for-byte against the registered
 * callback list — no wildcards, and `example.com` and `www.example.com`
 * are two unrelated entries as far as that check is concerned. Whoever
 * types one of them at setup time owns the DNS for the other, and which
 * of the two a browser ends up on is decided later by a redirect rule or
 * by whichever domain the host platform reports as canonical. Registering
 * the pair up front is what stops that from surfacing as
 * "redirect_uri is not associated with this application" at first sign-in.
 *
 * Only that one pairing is derived, and only for a real registrable
 * domain: `blog.example.com` gets no `www.blog…` sibling, and no `*.vercel.app`
 * project gets one either. Never widened to a host the user might not
 * control — a callback URL is where an authorization code gets delivered.
 */
export function callbackOriginVariants(origin: string): string[] {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return [trimTrailingSlash(origin)];
  }

  const canonical = url.origin;
  const host = url.hostname.toLowerCase();
  if (isPlatformHost(host)) return [canonical];

  const siblingHost = host.startsWith("www.") ? host.slice(4) : isApexHost(host) ? `www.${host}` : null;
  if (!siblingHost || isPlatformHost(siblingHost) || !isApexHost(siblingHost.replace(/^www\./, ""))) return [canonical];

  const sibling = new URL(url.toString());
  sibling.hostname = siblingHost;
  return [canonical, sibling.origin];
}

export function buildAppManifest(options: BuildAppManifestOptions): GithubAppManifest {
  const localOrigin = options.localOrigin ?? "http://localhost:3000";

  // Every origin is registered up front. GitHub Apps allow up to 10
  // callback URLs, and registering the localhost one now removes the
  // single most common follow-up support question ("sign-in works in
  // production but not on my machine") — there is no cost to declaring it.
  // Same reasoning for the apex/www sibling; see callbackOriginVariants.
  const callbackUrls = [
    ...(options.productionOrigin ? callbackOriginVariants(options.productionOrigin) : []).map((origin) => `${origin}${AUTH_CALLBACK_PATH}`),
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
