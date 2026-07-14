import { describe, expect, it } from "vitest";
import { findStaticContent } from "../analyze-static-content.js";
import { assertKeyAllowed, deriveKey, inferStaticSchema } from "../infer-static-schema.js";

describe("inferStaticSchema", () => {
  it("merges two paragraphs into one blocks field and resolves format to mdx", () => {
    const source = `
      export default function Page() {
        return <section id="hero"><h1>Welcome</h1><p>First</p><p>Second</p></section>;
      }
    `;
    const { staticContent } = findStaticContent(source, "/app/page.tsx");
    const proposal = inferStaticSchema(staticContent[0]!);

    const bodyFields = proposal.fields.filter((f) => f.proposedKind === "blocks");
    expect(bodyFields).toHaveLength(1);
    expect(bodyFields[0]!.name).toBe("body");
    expect(bodyFields[0]!.initialValue).toHaveLength(2);
    expect(proposal.format).toBe("mdx");

    const headingField = proposal.fields.find((f) => f.proposedKind === "text" && f.name === "heading");
    expect(headingField?.initialValue).toBe("Welcome");

    // fieldAssignments is parallel to the input candidate's fields (heading, first <p>, second <p>) —
    // both paragraphs point at the same merged "body" field name.
    expect(proposal.fieldAssignments).toEqual([
      { kind: "text", name: "heading" },
      { kind: "richParagraph", mergedFieldName: "body" },
      { kind: "richParagraph", mergedFieldName: "body" },
    ]);
  });

  it("resolves format to yaml when there is no rich paragraph content", () => {
    const source = `
      export default function Page() {
        return <section id="hero"><h1>Welcome</h1><img src="/a.jpg" alt="A" /></section>;
      }
    `;
    const { staticContent } = findStaticContent(source, "/app/page.tsx");
    const proposal = inferStaticSchema(staticContent[0]!);
    expect(proposal.format).toBe("yaml");
    expect(proposal.fields.some((f) => f.proposedKind === "blocks")).toBe(false);
  });

  it("numbers repeated roles (two <span> labels)", () => {
    const source = `
      export default function Page() {
        return <section id="hero"><span>First</span><span>Second</span></section>;
      }
    `;
    const { staticContent } = findStaticContent(source, "/app/page.tsx");
    const proposal = inferStaticSchema(staticContent[0]!);
    const names = proposal.fields.map((f) => f.name);
    expect(names).toEqual(["label", "label-2"]);
  });

  it("splits an image into an image field plus a sibling alt text field", () => {
    const source = `
      export default function Page() {
        return <section id="hero"><img src="/hero.jpg" alt="Hero shot" /></section>;
      }
    `;
    const { staticContent } = findStaticContent(source, "/app/page.tsx");
    const proposal = inferStaticSchema(staticContent[0]!);
    expect(proposal.fields).toEqual([
      { name: "image", label: "Image", proposedKind: "image", initialValue: "/hero.jpg" },
      { name: "image-alt", label: "Image Alt", proposedKind: "text", initialValue: "Hero shot" },
    ]);
  });

  it("splits a standalone CTA link into cta-label/cta-href text fields", () => {
    const source = `
      export default function Page() {
        return <section id="cta"><a href="/contact">Contact us</a></section>;
      }
    `;
    const { staticContent } = findStaticContent(source, "/app/page.tsx");
    const proposal = inferStaticSchema(staticContent[0]!);
    expect(proposal.fields).toEqual([
      { name: "cta-label", label: "Cta Label", proposedKind: "text", initialValue: "Contact us" },
      { name: "cta-href", label: "Cta Href", proposedKind: "text", initialValue: "/contact" },
    ]);
  });

  it("every generated field name matches the config key charset", () => {
    const source = `
      export default function Page() {
        return (
          <section id="hero">
            <h1>Welcome</h1>
            <h2>Sub</h2>
            <span>A</span>
            <span>B</span>
            <img src="/a.jpg" alt="A" />
            <a href="/x">Go</a>
            <p>Rich</p>
          </section>
        );
      }
    `;
    const { staticContent } = findStaticContent(source, "/app/page.tsx");
    const proposal = inferStaticSchema(staticContent[0]!);
    for (const field of proposal.fields) {
      expect(field.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe("deriveKey / assertKeyAllowed", () => {
  it("slugifies and suffixes on collision", () => {
    const existing = new Set<string>();
    expect(deriveKey("Hero Section", existing)).toBe("hero-section");
    expect(deriveKey("Hero Section", existing)).toBe("hero-section-2");
    expect(deriveKey("Hero Section", existing)).toBe("hero-section-3");
  });

  it("rejects a reserved top-level key", () => {
    expect(() => assertKeyAllowed("drafts")).toThrow(/reserved/);
  });

  it("rejects a key ending in a lock segment", () => {
    expect(() => assertKeyAllowed("home.lock")).toThrow(/lock/);
  });

  it("allows an ordinary dotted key", () => {
    expect(() => assertKeyAllowed("home.hero")).not.toThrow();
  });
});
