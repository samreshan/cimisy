import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FieldManifest } from "../../../next/manifest.js";
import { ArrayField } from "../array-field.js";

const field: FieldManifest = { name: "responsibilities", kind: "array", label: "Responsibilities" };

function render(value: unknown): string {
  return renderToStaticMarkup(<ArrayField field={field} value={value} onChange={() => {}} />);
}

describe("ArrayField", () => {
  it("renders an existing list's items instead of a blank input (regression: used to always render empty)", () => {
    const html = render(["Team leadership", "Mentoring"]);
    expect(html).toContain('value="Team leadership"');
    expect(html).toContain('value="Mentoring"');
  });

  it("shows an empty-state message and no rows when the array has no items yet", () => {
    const html = render([]);
    expect(html).toContain("No items yet.");
    expect(html).not.toContain("cimisy-input");
  });

  it("treats a non-array value (e.g. never-saved field) as an empty list rather than throwing", () => {
    const html = render(undefined);
    expect(html).toContain("No items yet.");
  });
});
