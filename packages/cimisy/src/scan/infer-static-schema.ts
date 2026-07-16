import { randomUUID } from "node:crypto";
import type { BlockNode } from "../config/fields/blocks.js";
import type { SeoValue } from "../config/fields/seo.js";
import { slugify } from "../shared/slug.js";
import type { StaticContentCandidate } from "./analyze-static-content.js";

/** "seo" is produced only by the page-metadata importer (apply-page-metadata.ts), never by inferStaticSchema below — static regions have no metadata to propose. */
export type StaticFieldProposalKind = "text" | "image" | "blocks" | "seo";

export interface StaticFieldProposal {
  name: string;
  label: string;
  proposedKind: StaticFieldProposalKind;
  initialValue: string | BlockNode[] | SeoValue;
}

/**
 * Parallel to a StaticContentCandidate's `fields` array — tells the source
 * codemod (rewrite-static-content-source.ts) exactly which generated field
 * name(s) each original scanned JSX node maps to, without needing to
 * re-derive this schema's own naming/merge logic independently.
 */
export type StaticFieldAssignment =
  | { kind: "text"; name: string }
  | { kind: "image"; name: string; altName: string }
  | { kind: "linkPair"; labelName: string; hrefName: string }
  | { kind: "richParagraph"; mergedFieldName: string };

export interface StaticSchemaProposal {
  fields: StaticFieldProposal[];
  format: "yaml" | "mdx";
  fieldAssignments: StaticFieldAssignment[];
}

function roleForTag(tag: string): string {
  if (tag === "h1") return "heading";
  if (/^h[2-6]$/.test(tag)) return "sub-heading";
  if (tag === "figcaption") return "caption";
  if (tag === "span") return "label";
  if (tag === "img" || tag === "Image") return "image";
  if (tag === "a" || tag === "Link") return "cta";
  return "field";
}

/** First occurrence of a role keeps the bare name; repeats get -2, -3, ... (never renumbering the first). */
function nextRoleName(counts: Map<string, number>, role: string): string {
  const n = (counts.get(role) ?? 0) + 1;
  counts.set(role, n);
  return slugify(n === 1 ? role : `${role}-${n}`);
}

function humanizeFieldName(name: string): string {
  return name
    .split("-")
    .map((word) => (word.length === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * Maps one scanned region's fields to a cimisy field schema. All
 * `richParagraph` values (from every <p>/<blockquote> in the region) merge
 * into a single `fields.blocks()` field named "body" — since blocks() is
 * itself an array field, N paragraphs become N array entries in one field,
 * never N separate body fields, which is what makes "one file, one format"
 * (yaml vs mdx) always resolvable. A <blockquote>'s distinct styling isn't
 * preserved in v1 — it serializes as a plain paragraph block, same as <p>;
 * revisiting this needs a dedicated quote/callout block type, out of scope
 * here.
 */
export function inferStaticSchema(candidate: StaticContentCandidate): StaticSchemaProposal {
  const fields: StaticFieldProposal[] = [];
  const fieldAssignments: StaticFieldAssignment[] = [];
  const counts = new Map<string, number>();
  const richParagraphs: BlockNode[] = [];
  const pendingRichIndices: number[] = [];

  candidate.fields.forEach((field, index) => {
    const { value } = field;
    if (value.kind === "richParagraph") {
      richParagraphs.push({ type: "paragraph", id: randomUUID(), props: { content: value.inline } });
      pendingRichIndices.push(index);
      fieldAssignments.push({ kind: "richParagraph", mergedFieldName: "" }); // backfilled once the body field name is known
      return;
    }
    if (value.kind === "text") {
      const name = nextRoleName(counts, roleForTag(field.tag));
      fields.push({ name, label: humanizeFieldName(name), proposedKind: "text", initialValue: value.text });
      fieldAssignments.push({ kind: "text", name });
      return;
    }
    if (value.kind === "image") {
      const base = nextRoleName(counts, "image");
      const altName = slugify(`${base}-alt`);
      fields.push({ name: base, label: humanizeFieldName(base), proposedKind: "image", initialValue: value.src });
      fields.push({ name: altName, label: humanizeFieldName(altName), proposedKind: "text", initialValue: value.alt });
      fieldAssignments.push({ kind: "image", name: base, altName });
      return;
    }
    // linkPair
    const base = nextRoleName(counts, "cta");
    const labelName = slugify(`${base}-label`);
    const hrefName = slugify(`${base}-href`);
    fields.push({ name: labelName, label: humanizeFieldName(labelName), proposedKind: "text", initialValue: value.label });
    fields.push({ name: hrefName, label: humanizeFieldName(hrefName), proposedKind: "text", initialValue: value.href });
    fieldAssignments.push({ kind: "linkPair", labelName, hrefName });
  });

  if (richParagraphs.length > 0) {
    const bodyName = nextRoleName(counts, "body");
    fields.push({ name: bodyName, label: humanizeFieldName(bodyName), proposedKind: "blocks", initialValue: richParagraphs });
    for (const index of pendingRichIndices) {
      fieldAssignments[index] = { kind: "richParagraph", mergedFieldName: bodyName };
    }
  }

  return { fields, format: richParagraphs.length > 0 ? "mdx" : "yaml", fieldAssignments };
}

const RESERVED_TOP_LEVEL_KEYS = new Set(["team", "drafts", "pages", "new"]);

/** Mirrors define-config.ts's claimKey reservations (kept separate/duplicated on purpose, same posture as its own KEY_SEGMENT_PATTERN comment) so scan-time reports the same refusal apply-time would hit, instead of letting a user pick a candidate that fails later with a raw config-time error. */
export function assertKeyAllowed(key: string): void {
  const segments = key.split(".");
  if (segments.length === 1 && RESERVED_TOP_LEVEL_KEYS.has(key)) {
    throw new Error(`"${key}" is reserved for the admin UI — pick a different id/className to derive the key from.`);
  }
  if (segments[segments.length - 1] === "lock") {
    throw new Error(`key "${key}" must not end in a "lock" segment (git rejects such branch names).`);
  }
}

/** Slugifies `hint` into a key, appending -2/-3/... on collision against `existingKeys` (which is mutated to reserve the chosen key). Shared by both section/singleton-key and (indirectly, via inferStaticSchema's own per-candidate counts) field-name derivation. */
export function deriveKey(hint: string, existingKeys: Set<string>): string {
  const base = slugify(hint);
  let key = base;
  let n = 2;
  while (existingKeys.has(key)) {
    key = `${base}-${n}`;
    n++;
  }
  existingKeys.add(key);
  return key;
}
