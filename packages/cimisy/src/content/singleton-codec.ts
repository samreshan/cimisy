import { parseDocument, stringify as stringifyYaml } from "yaml";
import type { NormalizedSingleton } from "../config/define-config.js";
import { ValidationError } from "../shared/errors.js";
import { parseEntry, serializeEntry } from "./codec.js";

/**
 * Singletons come in two on-disk shapes, chosen at config() time from the
 * schema: pure YAML (the whole file is the mapping — no frontmatter
 * fences) for all-frontmatter schemas, or regular MDX+frontmatter (the
 * entry codec, reused verbatim) when the schema has a body field. The
 * YAML branch mirrors the entry codec's fail-closed posture exactly: any
 * parse error OR warning rejects the file outright.
 */
export function serializeSingleton(def: NormalizedSingleton, values: Record<string, unknown>): string {
  if (def.format === "mdx") {
    return serializeEntry(def.schema, values);
  }
  const mapping: Record<string, unknown> = {};
  for (const fieldName of Object.keys(def.schema)) {
    const value = values[fieldName];
    mapping[fieldName] = value instanceof Date ? value.toISOString() : value;
  }
  return `${stringifyYaml(mapping).trimEnd()}\n`;
}

export function parseSingleton(def: NormalizedSingleton, raw: string): Record<string, unknown> {
  if (def.format === "mdx") {
    return parseEntry(def.schema, def.path, raw);
  }
  // parseDocument rather than the bare `parse` shortcut, same as
  // content/codec.ts's splitFrontmatter: warnings (e.g. unresolved !!js
  // tags) are treated as hard errors, not tolerated.
  const doc = parseDocument(raw);
  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    const issues = [...doc.errors, ...doc.warnings].map((e) => e.message).join("; ");
    throw new ValidationError(`Singleton "${def.path}" is not valid YAML: ${issues}`, null);
  }
  const parsed: unknown = doc.toJS();
  // Array.isArray too: a YAML sequence is typeof "object", and with field
  // defaults in play it would otherwise "parse" to an all-defaults mapping
  // instead of failing closed.
  if ((parsed !== null && parsed !== undefined && typeof parsed !== "object") || Array.isArray(parsed)) {
    throw new ValidationError(`Singleton "${def.path}" must be a YAML mapping.`, null);
  }
  const mapping = (parsed as Record<string, unknown> | null) ?? {};
  const values: Record<string, unknown> = {};
  for (const [fieldName, fieldDef] of Object.entries(def.schema)) {
    const result = fieldDef.zodSchema.safeParse(mapping[fieldName]);
    if (!result.success) {
      throw new ValidationError(`Field "${fieldName}" in ${def.path} failed validation.`, result.error.issues);
    }
    values[fieldName] = result.data;
  }
  return values;
}
