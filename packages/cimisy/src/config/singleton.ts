import type { FieldDefinition } from "./fields/types.js";

export interface SingletonOptions<Schema extends Record<string, FieldDefinition>> {
  label: string;
  /** e.g. "content/settings.yaml" — a single fixed file, not a glob. */
  path: string;
  schema: Schema;
  /**
   * Storage format. Derived from the schema when omitted: "mdx" iff any
   * field lives in the body (fields.blocks), otherwise plain YAML (the
   * whole file is the mapping — no frontmatter fences). "yaml" combined
   * with a body field is rejected at config() time.
   */
  format?: "yaml" | "mdx";
  /**
   * Where this content renders on the public site (e.g. "/about"). No
   * `:slug` placeholder — a singleton is one fixed page. Drives the admin
   * Preview link; omit for content with no page of its own (site settings).
   */
  previewPath?: string;
}

export interface SingletonDefinition<Schema extends Record<string, FieldDefinition> = Record<string, FieldDefinition>> {
  readonly type: "singleton";
  readonly label: string;
  readonly path: string;
  readonly schema: Schema;
  readonly format?: "yaml" | "mdx";
  readonly previewPath?: string;
}

export function singleton<Schema extends Record<string, FieldDefinition>>(
  options: SingletonOptions<Schema>,
): SingletonDefinition<Schema> {
  if (options.path.includes("*") || options.path.includes("..")) {
    throw new Error(`Singleton path "${options.path}" must be a fixed path (no "*" or "..").`);
  }
  return {
    type: "singleton",
    label: options.label,
    path: options.path,
    schema: options.schema,
    format: options.format,
    previewPath: options.previewPath,
  };
}
