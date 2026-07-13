import { resolveCollectionShape } from "../shared/slug.js";
import type { FieldDefinition } from "./fields/types.js";
import type { SlugFieldDefinition } from "./fields/slug.js";

export interface CollectionOptions<Schema extends Record<string, FieldDefinition>> {
  label: string;
  /**
   * e.g. "content/posts/*.mdx" — a single-segment glob, see shared/slug.ts.
   * Required for top-level collections; optional inside a page(), where the
   * normalizer derives "<pagePath>/<key>/*.mdx" from the page's directory.
   */
  path?: string;
  /** Name of the field (must be a fields.slug()) used to derive each entry's filename. */
  slugField: keyof Schema & string;
  schema: Schema;
  /**
   * Where an entry lives on the public site, as a template with a `:slug`
   * placeholder (e.g. "/blog/:slug"). A plain string (not a function) so
   * it's safe to send to the client as part of the admin manifest — when
   * set, the admin UI shows a "Preview" link for that collection; when
   * omitted, there's nowhere on the site to preview to, so no link.
   */
  previewPath?: string;
}

export interface CollectionDefinition<Schema extends Record<string, FieldDefinition> = Record<string, FieldDefinition>> {
  readonly type: "collection";
  readonly label: string;
  /** Unset only for page-nested collections that defer to the normalizer. */
  readonly path?: string;
  readonly directory?: string;
  readonly extension?: string;
  readonly slugField: string;
  readonly schema: Schema;
  readonly previewPath?: string;
}

export function collection<Schema extends Record<string, FieldDefinition>>(
  options: CollectionOptions<Schema>,
): CollectionDefinition<Schema> {
  // When a path is given, resolve it eagerly so a top-level misconfig
  // still fails at the definition site; pathless (page-nested) collections
  // are resolved — and re-validated — by config() normalization instead.
  const shape = options.path === undefined ? undefined : resolveCollectionShape(options.path);
  const slugFieldDef = options.schema[options.slugField];
  if (!slugFieldDef || slugFieldDef.kind !== "slug") {
    throw new Error(
      `Collection "${options.label}": slugField "${options.slugField}" must reference a fields.slug() field.`,
    );
  }
  void (slugFieldDef as SlugFieldDefinition);

  return {
    type: "collection",
    label: options.label,
    path: options.path,
    directory: shape?.directory,
    extension: shape?.extension,
    slugField: options.slugField,
    schema: options.schema,
    previewPath: options.previewPath,
  };
}
