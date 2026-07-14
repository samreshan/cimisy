import { describe, expect, it } from "vitest";
import { findStaticContent } from "../analyze-static-content.js";

describe("findStaticContent", () => {
  it("detects a heading, paragraph, and image inside a boundary <section>, with correct offsets", () => {
    const source = `
      export default function Home() {
        return (
          <section id="hero">
            <h1>Welcome</h1>
            <p>Subtitle</p>
            <img src="/hero.jpg" alt="Hero" />
          </section>
        );
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.unanalyzable).toEqual([]);
    expect(result.staticContent).toHaveLength(1);
    const candidate = result.staticContent[0]!;
    expect(candidate.regionHint).toBe("hero");
    expect(candidate.fields).toHaveLength(3);

    const heading = candidate.fields.find((f) => f.tag === "h1")!;
    expect(heading.value).toEqual({ kind: "text", text: "Welcome" });
    expect(source.slice(heading.nodeStart, heading.nodeEnd)).toBe("<h1>Welcome</h1>");

    const paragraph = candidate.fields.find((f) => f.tag === "p")!;
    expect(paragraph.value).toEqual({ kind: "richParagraph", inline: [{ type: "text", text: "Subtitle" }] });

    const image = candidate.fields.find((f) => f.tag === "img")!;
    expect(image.value).toEqual({ kind: "image", src: "/hero.jpg", alt: "Hero" });
  });

  it("excludes JSX text mixed with a non-literal expression", () => {
    const source = `
      const siteName = "Acme";
      export default function Page() {
        return <section id="hero"><h1>Welcome to {siteName}</h1></section>;
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.staticContent).toEqual([]);
    expect(result.unanalyzable).toHaveLength(1);
    expect(result.unanalyzable[0]!.reason).toMatch(/non-literal expression/);
    expect(result.unanalyzable[0]!.reason).toContain("siteName");
  });

  it("excludes a translation-call expression the same way, with no special-casing (i18n non-goal)", () => {
    const source = `
      export default function Page() {
        return <section id="hero"><h1>{t("hero.title")}</h1></section>;
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.staticContent).toEqual([]);
    expect(result.unanalyzable).toHaveLength(1);
    expect(result.unanalyzable[0]!.reason).toMatch(/non-literal expression/);
  });

  it("excludes a && conditionally-rendered element", () => {
    const source = `
      export default function Page() {
        return <div>{isOpen && <section id="banner"><h1>Special offer</h1></section>}</div>;
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.staticContent).toEqual([]);
    expect(result.unanalyzable).toHaveLength(1);
    expect(result.unanalyzable[0]!.reason).toMatch(/conditionally rendered/);
  });

  it("excludes a ternary-rendered element", () => {
    const source = `
      export default function Page() {
        return <div>{cond ? <p>A</p> : <p>B</p>}</div>;
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.staticContent).toEqual([]);
    expect(result.unanalyzable).toHaveLength(1);
    expect(result.unanalyzable[0]!.reason).toMatch(/conditionally rendered/);
  });

  it("never reads className/data-testid as content, using className only for region-hint derivation", () => {
    const source = `
      export default function Page() {
        return (
          <section className="hero-banner extra" data-testid="hero">
            <h1>Welcome</h1>
          </section>
        );
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.staticContent).toHaveLength(1);
    expect(result.staticContent[0]!.regionHint).toBe("hero-banner");
    expect(result.staticContent[0]!.fields[0]!.value).toEqual({ kind: "text", text: "Welcome" });
  });

  it("extracts rich inline content (strong + Link) inside a paragraph", () => {
    const source = `
      export default function Page() {
        return <section id="hero"><p>Some <strong>rich</strong> text with a <Link href="/x">link</Link></p></section>;
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.unanalyzable).toEqual([]);
    const field = result.staticContent[0]!.fields[0]!;
    expect(field.value.kind).toBe("richParagraph");
    if (field.value.kind !== "richParagraph") throw new Error("expected richParagraph");
    const linkNode = field.value.inline.find((n) => n.type === "link");
    expect(linkNode).toEqual({ type: "link", href: "/x", children: [{ type: "text", text: "link" }] });
  });

  it("refuses a heading with rich (nested-element) children — headings are plain-string only", () => {
    const source = `
      export default function Page() {
        return <section id="hero"><h1>Welcome to <strong>Sunflower</strong></h1></section>;
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.staticContent).toEqual([]);
    expect(result.unanalyzable[0]!.reason).toMatch(/nested element <strong>/);
  });

  it("refuses an ESM-imported image (src is an identifier, not a string literal)", () => {
    const source = `
      import heroImg from "./hero.png";
      export default function Page() {
        return <section id="hero"><img src={heroImg} alt="Hero" /></section>;
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.staticContent).toEqual([]);
    expect(result.unanalyzable[0]!.reason).toMatch(/not supported yet/);
  });

  it("treats a standalone CTA link (not inside a paragraph) as a linkPair, not a rich-paragraph merge", () => {
    const source = `
      export default function Page() {
        return <section id="cta"><div><a href="/contact">Contact us</a></div></section>;
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.unanalyzable).toEqual([]);
    const field = result.staticContent[0]!.fields[0]!;
    expect(field.value).toEqual({ kind: "linkPair", label: "Contact us", href: "/contact" });
  });

  it("produces two separate candidates for two sibling <section>s", () => {
    const source = `
      export default function Page() {
        return (
          <div>
            <section id="hero"><h1>Hero</h1></section>
            <section id="cta"><h1>CTA</h1></section>
          </div>
        );
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.staticContent.map((c) => c.regionHint).sort()).toEqual(["cta", "hero"]);
  });

  it("falls back to one region keyed by the component name when there is no boundary tag", () => {
    const source = `
      export default function HomePage() {
        return <div><h1>Welcome</h1><p>Subtitle</p></div>;
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.staticContent).toHaveLength(1);
    expect(result.staticContent[0]!.regionHint).toBe("HomePage");
    expect(result.staticContent[0]!.fields).toHaveLength(2);
  });

  it("silently skips content inside a .map() callback (out of scope — that's the collection scanner's job)", () => {
    const source = `
      export default function Page() {
        const items = [{ title: "A" }];
        return <section id="list">{items.map((i) => <h1 key={i.title}>{i.title}</h1>)}</section>;
      }
    `;
    const result = findStaticContent(source, "/app/page.tsx");
    expect(result.staticContent).toEqual([]);
    expect(result.unanalyzable).toEqual([]);
  });
});
