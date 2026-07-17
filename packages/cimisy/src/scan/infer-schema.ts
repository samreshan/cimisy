import type { LiteralValue } from "./analyze-source.js";

export type ProposedFieldKind = "text" | "image" | "array-of-text" | "boolean" | "number";
export type SourceValueKind = "string" | "number" | "boolean" | "array" | "null" | "mixed";

export interface FieldProposal {
  name: string;
  proposedKind: ProposedFieldKind;
  /** The raw literal-value JS shape observed across items, before field-kind inference. Lets the apply step know whether values need stringifying before writeEntry. */
  sourceKind: SourceValueKind;
  /** True when at least one item was missing this key (or had it null). */
  optional: boolean;
  note?: string;
}

export interface CollectionSchemaProposal {
  /** Inferred content fields — does NOT include the synthesized slug field. */
  fields: FieldProposal[];
  /** Name of the synthesized fields.slug() field that will be added. */
  slugField: string;
  /** Which text field the slug is derived from (fields.slug({ source })). */
  slugSourceField: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}(-\d{2})?$|^[A-Za-z]+ \d{4}$|^[A-Za-z]+ \d{1,2},? \d{4}$/;
const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|svg|webp|gif|avif)$/i;

function looksLikeDate(value: string): boolean {
  return DATE_PATTERN.test(value.trim()) && !Number.isNaN(Date.parse(value));
}

function looksLikeImagePath(value: string): boolean {
  return (value.startsWith("/") || value.startsWith("http://") || value.startsWith("https://")) && IMAGE_EXTENSION_PATTERN.test(value);
}

function classifySourceKind(values: LiteralValue[]): SourceValueKind {
  const nonNull = values.filter((v) => v !== null);
  if (nonNull.length === 0) return "null";
  const kinds = new Set(nonNull.map((v) => (Array.isArray(v) ? "array" : typeof v)));
  if (kinds.size > 1) return "mixed";
  const [kind] = kinds;
  if (kind === "string" || kind === "number" || kind === "boolean" || kind === "array") return kind;
  return "mixed";
}

function inferField(name: string, values: LiteralValue[], presentOnEveryItem: boolean): FieldProposal {
  const sourceKind = classifySourceKind(values);
  const optional = !presentOnEveryItem || values.includes(null);
  const stringValues = values.filter((v): v is string => typeof v === "string");

  if (sourceKind === "array") {
    const allStringElements = values.every((v) => Array.isArray(v) && v.every((el) => typeof el === "string"));
    return {
      name,
      sourceKind,
      optional,
      proposedKind: "array-of-text",
      note: allStringElements ? undefined : "array items are not all plain strings; non-string items will be stored as text",
    };
  }

  if (sourceKind === "string") {
    // Deliberately NOT proposed as a real fields.date() — that field coerces to a Date object on
    // read (z.coerce.date()), which would silently change rendered output for whatever arbitrary
    // string format the original hardcoded value used (e.g. "April 2026"). Text preserves the
    // original string byte-for-byte; the note still signals it visually looks like a date.
    if (stringValues.length > 0 && stringValues.every(looksLikeDate)) {
      return {
        name,
        sourceKind,
        optional,
        proposedKind: "text",
        note: "looks like a date, but stored as plain text to preserve the exact original formatting",
      };
    }
    if (stringValues.length > 0 && stringValues.every(looksLikeImagePath)) {
      return {
        name,
        sourceKind,
        optional,
        proposedKind: "image",
        note: "looks like an image path — confirm the target directory before importing",
      };
    }
    return { name, sourceKind, optional, proposedKind: "text" };
  }

  // Numbers and booleans map to their real field types (fields.number() /
  // fields.boolean(), added in 2.4) — the value round-trips as its actual
  // YAML type, so pre-existing truthy checks and arithmetic keep working.
  // (Before fields.boolean() existed, booleans imported as literal
  // "true"/"false" strings and needed a loud warning about inverted
  // truthiness; that whole caveat is gone.)
  if (sourceKind === "number") {
    return { name, sourceKind, optional, proposedKind: "number" };
  }

  if (sourceKind === "boolean") {
    return { name, sourceKind, optional, proposedKind: "boolean" };
  }

  if (sourceKind === "null") {
    return { name, sourceKind, optional: true, proposedKind: "text", note: "all observed values are null; defaulting to a text field" };
  }

  return {
    name,
    sourceKind,
    optional,
    proposedKind: "text",
    note: "values have inconsistent types across items; defaulting to a text field — review before importing",
  };
}

function pickSlugSourceField(fields: FieldProposal[]): string {
  const textFields = fields.filter((f) => f.proposedKind === "text");
  const byName = (name: string) => textFields.find((f) => f.name.toLowerCase() === name);
  return (byName("title") ?? byName("name") ?? byName("heading") ?? textFields[0] ?? fields[0])?.name ?? "title";
}

/** Unions keys/types across an array candidate's items and proposes a cimisy field schema, including a synthesized slug field (every cimisy collection needs one). */
export function inferSchema(items: Array<Record<string, LiteralValue>>): CollectionSchemaProposal {
  const keyOrder: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!seen.has(key)) {
        seen.add(key);
        keyOrder.push(key);
      }
    }
  }

  const fields = keyOrder.map((key) => {
    const values = items.map((item) => (key in item ? item[key]! : null));
    const presentOnEveryItem = items.every((item) => key in item);
    return inferField(key, values, presentOnEveryItem);
  });

  const slugSourceField = pickSlugSourceField(fields);
  const slugField = seen.has("slug") ? "entrySlug" : "slug";

  return { fields, slugField, slugSourceField };
}
