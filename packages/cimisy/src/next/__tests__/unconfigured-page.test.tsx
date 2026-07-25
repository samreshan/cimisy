import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { collection, config, fields } from "../../config/index.js";
import { unconfiguredSource } from "../../storage/unconfigured.js";
import { CimisyAdminPage } from "../admin-page.js";
import { CimisyUnconfiguredPage } from "../unconfigured-page.js";

const MISSING = ["CIMISY_GITHUB_APP_PRIVATE_KEY", "CIMISY_SESSION_SECRET"];

/** The page is an async server component; outside a request scope its `next/headers` lookup falls back, which is exactly the path this exercises. */
async function renderPage(missing: readonly string[] = MISSING): Promise<string> {
  return renderToStaticMarkup(await CimisyUnconfiguredPage({ missing }));
}

describe("CimisyUnconfiguredPage", () => {
  it("lists the missing variable names and how to fix them", async () => {
    const html = await renderPage();
    expect(html).toContain("cimisy is not configured");
    for (const name of MISSING) expect(html).toContain(name);
    expect(html).toContain("npx cimisy setup github");
    expect(html).toContain("CIMISY_CONFIG");
    expect(html).toContain("npx cimisy doctor");
  });

  it("shows the callback URL, falling back to a placeholder outside a request scope", async () => {
    expect(await renderPage()).toContain("/api/cimisy/auth/callback");
  });

  it("holds no inputs, no forms, and no client script — it must never become a credential form", async () => {
    const html = await renderPage();
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<button");
  });

  it("renders cleanly with an empty missing list", async () => {
    await expect(renderPage([])).resolves.toContain("cimisy is not configured");
  });
});

describe("CimisyAdminPage routing", () => {
  it("renders the instructions page instead of the admin UI when the source is unconfigured", async () => {
    const cimisyConfig = config({
      source: unconfiguredSource({ missing: MISSING }),
      collections: {
        posts: collection({
          label: "Posts",
          path: "content/posts/*.mdx",
          slugField: "slug",
          schema: { title: fields.text({ label: "Title" }), slug: fields.slug({ source: "title" }) },
        }),
      },
    });
    const element = CimisyAdminPage({ cimisyConfig, segments: [], basePath: "/admin", apiBasePath: "/api/cimisy" });
    // The admin UI is a client component and can't be server-rendered here;
    // asserting on the element type is enough to prove which branch ran.
    expect((element as { type?: unknown }).type).toBe(CimisyUnconfiguredPage);
  });
});
