import { describe, expect, it } from "vitest";
import { mapIssuesToFieldErrors, requiredFieldErrors } from "../entry-form.js";

const FIELD_NAMES = ["title", "subtitle", "slug"];

describe("mapIssuesToFieldErrors", () => {
  it("maps field-prefixed issues to their field, first message per field wins", () => {
    const { fieldErrors, unmapped } = mapIssuesToFieldErrors(
      [
        { path: ["title"], message: "Required." },
        { path: ["title"], message: "Second message loses." },
        { path: ["subtitle", 2], message: "Nested path still maps to the field." },
      ],
      FIELD_NAMES,
    );
    expect(fieldErrors).toEqual({ title: "Required.", subtitle: "Nested path still maps to the field." });
    expect(unmapped).toEqual([]);
  });

  it("collects issues that name no known field as unmapped for the generic banner", () => {
    const { fieldErrors, unmapped } = mapIssuesToFieldErrors(
      [{ path: [], message: "Request body failed validation." }, { path: ["ghost"], message: "Unknown field." }],
      FIELD_NAMES,
    );
    expect(fieldErrors).toEqual({});
    expect(unmapped).toEqual(["Request body failed validation.", "Unknown field."]);
  });

  it("tolerates non-array and malformed issues payloads", () => {
    expect(mapIssuesToFieldErrors(null, FIELD_NAMES)).toEqual({ fieldErrors: {}, unmapped: [] });
    expect(mapIssuesToFieldErrors("boom", FIELD_NAMES)).toEqual({ fieldErrors: {}, unmapped: [] });
    const { unmapped } = mapIssuesToFieldErrors([{}], FIELD_NAMES);
    expect(unmapped).toEqual(["Invalid value."]);
  });
});

describe("requiredFieldErrors", () => {
  const fields = [
    { name: "title", kind: "text", label: "Title", required: true },
    { name: "subtitle", kind: "text", label: "Subtitle" },
  ];

  it("flags missing and empty required fields, ignores optional ones", () => {
    expect(requiredFieldErrors(fields, {})).toEqual({ title: "Required." });
    expect(requiredFieldErrors(fields, { title: "" })).toEqual({ title: "Required." });
    expect(requiredFieldErrors(fields, { title: "Hi" })).toEqual({});
  });
});
