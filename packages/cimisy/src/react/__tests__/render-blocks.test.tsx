import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultBlockComponents, renderBlocks } from "../render-blocks.js";

function render(nodes: ReturnType<typeof renderBlocks>): string {
  return renderToStaticMarkup(<>{nodes}</>);
}

describe("renderBlocks", () => {
  it("renders paragraph/heading/code/image/callout with the default components", () => {
    const html = render(
      renderBlocks([
        { type: "heading", id: "1", props: { level: 2, text: "Title" } },
        { type: "paragraph", id: "2", props: { text: "Body text." } },
        { type: "image", id: "3", props: { src: "/a.png", alt: "desc" } },
        { type: "callout", id: "4", props: { tone: "info", text: "Note." } },
        { type: "code", id: "5", props: { code: "const x = 1;", language: "ts" } },
      ]),
    );

    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<p>Body text.</p>");
    expect(html).toContain('<img src="/a.png" alt="desc"/>');
    expect(html).toContain('data-cimisy-callout="info"');
    expect(html).toContain("Note.");
    expect(html).toContain('language-ts');
    expect(html).toContain("const x = 1;");
  });

  it("clamps a heading level outside 1-6 rather than emitting an invalid tag", () => {
    const html = render(renderBlocks([{ type: "heading", id: "1", props: { level: 9, text: "x" } }]));
    expect(html).toContain("<h6>x</h6>");
  });

  it("throws when a block type has no matching component (missing from the components map)", () => {
    expect(() => renderBlocks([{ type: "unregistered", id: "1", props: {} }])).toThrow(/no component registered/);
  });

  it("supports overriding a default component (e.g. swapping in a custom Image)", () => {
    const CustomImage = ({ src }: { src: string }) => <span data-custom-image={src} />;
    const html = render(
      renderBlocks([{ type: "image", id: "1", props: { src: "/a.png", alt: "x" } }], {
        ...defaultBlockComponents,
        image: CustomImage,
      }),
    );
    expect(html).toContain('data-custom-image="/a.png"');
    expect(html).not.toContain("<img");
  });

  it("preserves block order in the output", () => {
    const html = render(
      renderBlocks([
        { type: "paragraph", id: "1", props: { text: "First" } },
        { type: "paragraph", id: "2", props: { text: "Second" } },
        { type: "paragraph", id: "3", props: { text: "Third" } },
      ]),
    );
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
    expect(html.indexOf("Second")).toBeLessThan(html.indexOf("Third"));
  });
});
