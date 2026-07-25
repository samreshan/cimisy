import { describe, expect, it } from "vitest";
import { AUTH_CALLBACK_PATH, buildAppManifest, manifestRegistrationUrl, MAX_APP_NAME_LENGTH, suggestAppName } from "../manifest.js";

const REDIRECT = "http://127.0.0.1:51234/callback";

describe("suggestAppName", () => {
  it("prefixes the repo name and slugifies it", () => {
    expect(suggestAppName("acme/my-site")).toBe("cimisy-my-site");
    expect(suggestAppName("acme/My_Site.dev")).toBe("cimisy-my-site-dev");
  });

  it("never exceeds GitHub's 34-character cap, and never ends on a dangling dash", () => {
    const name = suggestAppName(`acme/${"a".repeat(80)}`);
    expect(name.length).toBeLessThanOrEqual(MAX_APP_NAME_LENGTH);
    expect(name.endsWith("-")).toBe(false);
    expect(suggestAppName(`acme/${"a".repeat(26)}-tail`).endsWith("-")).toBe(false);
  });

  it("accepts a bare repo name with no owner", () => {
    expect(suggestAppName("site")).toBe("cimisy-site");
  });
});

describe("buildAppManifest", () => {
  const manifest = buildAppManifest({
    appName: "cimisy-my-site",
    repo: "acme/my-site",
    productionOrigin: "https://my-site.vercel.app",
    redirectUrl: REDIRECT,
  });

  it("declares exactly the permissions cimisy needs and no more", () => {
    // Locked down deliberately: this is the App's blast radius if its
    // private key ever leaks, so a change here should be a conscious one.
    expect(manifest.default_permissions).toEqual({
      contents: "write",
      pull_requests: "write",
      members: "read",
    });
  });

  it("registers both the production and the localhost callback", () => {
    expect(manifest.callback_urls).toEqual([
      `https://my-site.vercel.app${AUTH_CALLBACK_PATH}`,
      `http://localhost:3000${AUTH_CALLBACK_PATH}`,
    ]);
  });

  it("subscribes to no events and declares no webhook", () => {
    expect(manifest.default_events).toEqual([]);
    expect(manifest).not.toHaveProperty("hook_attributes");
  });

  it("is private and asks for OAuth on install", () => {
    expect(manifest.public).toBe(false);
    expect(manifest.request_oauth_on_install).toBe(true);
  });

  it("points redirect_url at the wizard's temp server", () => {
    expect(manifest.redirect_url).toBe(REDIRECT);
  });

  it("matches its full snapshot", () => {
    expect(manifest).toMatchInlineSnapshot(`
      {
        "callback_urls": [
          "https://my-site.vercel.app/api/cimisy/auth/callback",
          "http://localhost:3000/api/cimisy/auth/callback",
        ],
        "default_events": [],
        "default_permissions": {
          "contents": "write",
          "members": "read",
          "pull_requests": "write",
        },
        "description": "Content management for acme/my-site, powered by cimisy.",
        "name": "cimisy-my-site",
        "public": false,
        "redirect_url": "http://127.0.0.1:51234/callback",
        "request_oauth_on_install": true,
        "url": "https://my-site.vercel.app",
      }
    `);
  });

  it("falls back to the repo URL as the homepage when no production origin is given", () => {
    const localOnly = buildAppManifest({ appName: "cimisy-my-site", repo: "acme/my-site", redirectUrl: REDIRECT });
    expect(localOnly.url).toBe("https://github.com/acme/my-site");
    expect(localOnly.callback_urls).toEqual([`http://localhost:3000${AUTH_CALLBACK_PATH}`]);
  });

  it("strips a trailing slash from the production origin rather than emitting a double slash", () => {
    const trailing = buildAppManifest({
      appName: "cimisy-my-site",
      repo: "acme/my-site",
      productionOrigin: "https://my-site.vercel.app/",
      redirectUrl: REDIRECT,
    });
    expect(trailing.callback_urls[0]).toBe(`https://my-site.vercel.app${AUTH_CALLBACK_PATH}`);
  });

  it("de-duplicates when the production origin is localhost itself", () => {
    const same = buildAppManifest({
      appName: "cimisy-my-site",
      repo: "acme/my-site",
      productionOrigin: "https://localhost:3000",
      localOrigin: "https://localhost:3000",
      redirectUrl: REDIRECT,
    });
    expect(same.callback_urls).toHaveLength(1);
  });
});

describe("manifestRegistrationUrl", () => {
  it("targets personal settings by default and org settings for an org", () => {
    expect(manifestRegistrationUrl({})).toBe("https://github.com/settings/apps/new");
    expect(manifestRegistrationUrl({ org: "acme" })).toBe("https://github.com/organizations/acme/settings/apps/new");
  });

  it("encodes an org name rather than interpolating it raw into the path", () => {
    expect(manifestRegistrationUrl({ org: "a/b" })).toBe("https://github.com/organizations/a%2Fb/settings/apps/new");
  });
});
