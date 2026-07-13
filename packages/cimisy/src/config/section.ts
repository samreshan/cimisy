import type { FieldDefinition } from "./fields/types.js";

export interface SectionOptions<Schema extends Record<string, FieldDefinition>> {
  label: string;
  schema: Schema;
  /**
   * Storage format for the section's single file. Derived from the schema
   * when omitted: "mdx" iff any field lives in the body (fields.blocks),
   * otherwise plain YAML (the whole file is the mapping — no frontmatter
   * fences). "yaml" combined with a body field is rejected at config()
   * time.
   */
  format?: "yaml" | "mdx";
}

export interface SectionDefinition<Schema extends Record<string, FieldDefinition> = Record<string, FieldDefinition>> {
  readonly type: "section";
  readonly label: string;
  readonly schema: Schema;
  readonly format?: "yaml" | "mdx";
}

/**
 * A named block of static content inside a page() — singleton-shaped (one
 * fixed file, no slug), with its path derived from the page's directory
 * and the section's key during config() normalization.
 */
export function section<Schema extends Record<string, FieldDefinition>>(
  options: SectionOptions<Schema>,
): SectionDefinition<Schema> {
  return {
    type: "section",
    label: options.label,
    schema: options.schema,
    format: options.format,
  };
}
