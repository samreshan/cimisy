import { describe, expect, it } from "vitest";
import { createMetadata, toNextMetadata } from "../metadata.js";
import { seoDefaultsFromSettings } from "../settings.js";

const DEFAULTS = {
  siteName: "Acme",
  titleTemplate: "%s — Acme",
  description: "Default description",
  siteUrl: "https://example.com",
  ogImage: "/uploads/default-og.png",
  twitterHandle: "@acme",
};

describe("createMetadata precedence", () => {
  it("entry seo value wins over fallback, which wins over site defaults", () => {
    const metadata = createMetadata({
      seo: { title: "SEO Title" },
      fallback: { title: "Entry Title", description: "Entry description" },
      defaults: DEFAULTS,
    });
    expect(metadata.title).toBe("SEO Title — Acme");
    expect(metadata.description).toBe("Entry description");

    const noSeo = createMetadata({ fallback: { title: "Entry Title" }, defaults: DEFAULTS });
    expect(noSeo.title).toBe("Entry Title — Acme");
    expect(noSeo.description).toBe("Default description");
  });

  it("applies the title template only when there is a title to apply it to", () => {
    const metadata = createMetadata({ defaults: DEFAULTS });
    expect(metadata.title).toBeUndefined();
  });

  it("noindex maps to robots index:false, follow:false; absent noindex sets no robots at all", () => {
    expect(createMetadata({ seo: { noindex: true } }).robots).toEqual({ index: false, follow: false });
    expect(createMetadata({ seo: {} }).robots).toBeUndefined();
  });

  it("resolves canonical from the seo value, else the current path, against siteUrl", () => {
    expect(createMetadata({ seo: { canonical: "/custom" }, path: "/actual", defaults: DEFAULTS }).alternates).toEqual({
      canonical: "https://example.com/custom",
    });
    expect(createMetadata({ path: "/blog/x", defaults: DEFAULTS }).alternates).toEqual({
      canonical: "https://example.com/blog/x",
    });
    expect(createMetadata({ seo: { canonical: "https://elsewhere.example/x" }, defaults: DEFAULTS }).alternates).toEqual({
      canonical: "https://elsewhere.example/x",
    });
    expect(createMetadata({ seo: {} }).alternates).toBeUndefined();
  });

  it("builds openGraph and twitter blocks with the resolved image (absolute URL)", () => {
    const metadata = createMetadata({
      seo: { title: "T", description: "D", ogImage: "uploads/x.png" },
      path: "/p",
      defaults: DEFAULTS,
    });
    expect(metadata.openGraph).toMatchObject({
      title: "T — Acme",
      siteName: "Acme",
      url: "https://example.com/p",
      images: [{ url: "https://example.com/uploads/x.png" }],
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      site: "@acme",
      images: ["https://example.com/uploads/x.png"],
    });
  });

  it("toNextMetadata is the defaults-only shorthand", () => {
    const metadata = toNextMetadata({ title: "Hello" }, DEFAULTS);
    expect(metadata.title).toBe("Hello — Acme");
  });
});

describe("seoDefaultsFromSettings", () => {
  it("maps the conventional settings fields, dropping empty/missing/non-string ones", () => {
    expect(
      seoDefaultsFromSettings({
        siteName: "Acme",
        titleTemplate: "",
        description: 42,
        siteUrl: "https://example.com",
      }),
    ).toEqual({
      siteName: "Acme",
      titleTemplate: undefined,
      description: undefined,
      siteUrl: "https://example.com",
      ogImage: undefined,
      twitterHandle: undefined,
    });
    expect(seoDefaultsFromSettings(undefined)).toEqual({});
  });
});
