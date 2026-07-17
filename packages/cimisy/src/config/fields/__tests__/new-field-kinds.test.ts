import { describe, expect, it } from "vitest";
import { validateFieldValues } from "../../../content/validate-values.js";
import { fields } from "../index.js";

describe("fields.boolean()", () => {
  it("round-trips a real boolean and defaults an untouched field to false", () => {
    const schema = { featured: fields.boolean({ label: "Featured" }) };
    expect(validateFieldValues(schema, { featured: true })).toEqual({ featured: true });
    expect(validateFieldValues(schema, {})).toEqual({ featured: false });
  });

  it('rejects the string "true" — booleans are stored as booleans, never coerced strings', () => {
    const schema = { featured: fields.boolean({ label: "Featured" }) };
    expect(() => validateFieldValues(schema, { featured: "true" })).toThrow();
  });
});

describe("fields.number()", () => {
  it("round-trips a number and defaults an untouched optional field to null", () => {
    const schema = { priority: fields.number({ label: "Priority" }) };
    expect(validateFieldValues(schema, { priority: 3 })).toEqual({ priority: 3 });
    expect(validateFieldValues(schema, {})).toEqual({ priority: null });
  });

  it("enforces min/max and required", () => {
    const schema = { priority: fields.number({ label: "Priority", validation: { isRequired: true, min: 1, max: 5 } }) };
    expect(validateFieldValues(schema, { priority: 5 })).toEqual({ priority: 5 });
    expect(() => validateFieldValues(schema, { priority: 9 })).toThrow();
    expect(() => validateFieldValues(schema, {})).toThrow();
  });

  it('rejects a numeric string ("3") — no silent coercion', () => {
    const schema = { priority: fields.number({ label: "Priority" }) };
    expect(() => validateFieldValues(schema, { priority: "3" })).toThrow();
  });
});

describe("fields.select()", () => {
  it("accepts declared options and defaults an untouched optional field to \"\"", () => {
    const schema = { tone: fields.select({ label: "Tone", options: ["info", "warning"] }) };
    expect(validateFieldValues(schema, { tone: "warning" })).toEqual({ tone: "warning" });
    expect(validateFieldValues(schema, {})).toEqual({ tone: "" });
  });

  it("rejects a value outside the options, and \"\" when required", () => {
    const optional = { tone: fields.select({ label: "Tone", options: ["info", "warning"] }) };
    expect(() => validateFieldValues(optional, { tone: "danger" })).toThrow();
    const required = { tone: fields.select({ label: "Tone", options: ["info", "warning"], validation: { isRequired: true } }) };
    expect(() => validateFieldValues(required, { tone: "" })).toThrow();
  });

  it("refuses an empty options list at config time", () => {
    expect(() => fields.select({ label: "Tone", options: [] })).toThrow();
  });
});

describe("fields.text({ multiline: true })", () => {
  it("keeps identical storage/validation semantics to single-line text", () => {
    const schema = { bio: fields.text({ label: "Bio", multiline: true }) };
    expect(validateFieldValues(schema, { bio: "line one\nline two" })).toEqual({ bio: "line one\nline two" });
    expect(validateFieldValues(schema, {})).toEqual({ bio: "" });
  });
});
