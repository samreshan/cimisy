import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { articleJsonLd, breadcrumbListJsonLd, JsonLd, organizationJsonLd, webSiteJsonLd } from "../json-ld.js";

describe("JSON-LD builders", () => {
  it("articleJsonLd emits the expected shape, dropping undefined properties", () => {
    const node = articleJsonLd({
      headline: "Hello",
      datePublished: new Date("2026-01-02T00:00:00Z"),
      authorName: "Alice",
      publisher: { name: "Acme", logo: "https://example.com/logo.png" },
    });
    expect(node).toEqual({
      "@type": "Article",
      headline: "Hello",
      datePublished: "2026-01-02T00:00:00.000Z",
      author: { "@type": "Person", name: "Alice" },
      publisher: { "@type": "Organization", name: "Acme", logo: { "@type": "ImageObject", url: "https://example.com/logo.png" } },
    });
    expect("description" in node).toBe(false);
  });

  it("overrides shallow-merge last (the CMS-editable hook)", () => {
    const node = articleJsonLd({ headline: "Hello", overrides: { headline: "Overridden", wordCount: 42 } });
    expect(node.headline).toBe("Overridden");
    expect(node.wordCount).toBe(42);
  });

  it("breadcrumbListJsonLd numbers positions from 1", () => {
    expect(breadcrumbListJsonLd([{ name: "Home", url: "/" }, { name: "Blog", url: "/blog" }]).itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "/" },
      { "@type": "ListItem", position: 2, name: "Blog", item: "/blog" },
    ]);
  });

  it("organization and webSite builders emit their types", () => {
    expect(organizationJsonLd({ name: "Acme" })["@type"]).toBe("Organization");
    expect(webSiteJsonLd({ name: "Acme", url: "https://example.com" })["@type"]).toBe("WebSite");
  });
});

describe("<JsonLd> XSS hardening", () => {
  it("renders a script tag with @context added", () => {
    const html = renderToStaticMarkup(<JsonLd data={webSiteJsonLd({ name: "Acme", url: "https://example.com" })} />);
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@context":"https://schema.org"');
  });

  it("a </script> payload in CMS-edited content cannot break out of the script element", () => {
    const html = renderToStaticMarkup(
      <JsonLd data={articleJsonLd({ headline: '</script><script>alert(1)</script>' })} />,
    );
    expect(html).not.toContain("</script><script>");
    expect(html).toContain("\\u003c/script");
  });

  it("escapes U+2028/U+2029 line separators", () => {
    const html = renderToStaticMarkup(<JsonLd data={articleJsonLd({ headline: "a\u2028b\u2029c" })} />);
    expect(html).toContain("\\u2028");
    expect(html).toContain("\\u2029");
  });

  it("wraps an array of nodes, each with @context", () => {
    const html = renderToStaticMarkup(
      <JsonLd data={[organizationJsonLd({ name: "Acme" }), webSiteJsonLd({ name: "Acme", url: "https://x.example" })]} />,
    );
    expect(html.match(/@context/g)).toHaveLength(2);
  });
});
