import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminManifest, ManifestTreeNode } from "../../../next/manifest.js";
import { ContentTree } from "../collections.js";

function render(manifest: AdminManifest): string {
  return renderToStaticMarkup(<ContentTree manifest={manifest} basePath="/admin" />);
}

function manifestWithTree(tree: ManifestTreeNode[]): AdminManifest {
  return { tree, byKey: {}, draftsSupported: false, scanSupported: false };
}

describe("ContentTree page-group static/collection separation", () => {
  it("renders separate labeled sub-lists for static content and collections within one page", () => {
    const html = render(
      manifestWithTree([
        {
          kind: "page",
          key: "home",
          label: "Home",
          route: "/",
          children: [
            { kind: "singleton", key: "home.hero", label: "Hero", fields: [] },
            { kind: "singleton", key: "home.cta", label: "Cta", fields: [] },
            { kind: "collection", key: "home.testimonials", label: "Testimonials", slugField: "slug", fields: [] },
          ],
        },
      ]),
    );

    expect(html).toContain("Static content");
    expect(html).toContain("Collections");
    const staticIndex = html.indexOf("Static content");
    const collectionsIndex = html.indexOf("Collections");
    const heroIndex = html.indexOf("Hero");
    const testimonialsIndex = html.indexOf("Testimonials");
    // Hero (static) appears after the "Static content" label and before "Collections"; Testimonials appears after "Collections".
    expect(staticIndex).toBeLessThan(heroIndex);
    expect(heroIndex).toBeLessThan(collectionsIndex);
    expect(collectionsIndex).toBeLessThan(testimonialsIndex);
  });

  it("renders only the static sub-list when a page has no collections", () => {
    const html = render(
      manifestWithTree([
        {
          kind: "page",
          key: "home",
          label: "Home",
          children: [{ kind: "singleton", key: "home.hero", label: "Hero", fields: [] }],
        },
      ]),
    );
    expect(html).toContain("Static content");
    expect(html).not.toContain("Collections");
  });

  it("renders only the collections sub-list when a page has no static content", () => {
    const html = render(
      manifestWithTree([
        {
          kind: "page",
          key: "home",
          label: "Home",
          children: [{ kind: "collection", key: "home.posts", label: "Posts", slugField: "slug", fields: [] }],
        },
      ]),
    );
    expect(html).toContain("Collections");
    expect(html).not.toContain("Static content");
  });

  it("badges a collection as \"collection\" and a singleton/section as \"static\"", () => {
    const html = render(
      manifestWithTree([
        { kind: "singleton", key: "settings", label: "Settings", fields: [] },
        { kind: "collection", key: "posts", label: "Posts", slugField: "slug", fields: [] },
      ]),
    );
    expect(html).toContain(">static<");
    expect(html).toContain(">collection<");
  });
});
