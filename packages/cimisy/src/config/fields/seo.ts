import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export interface SeoValue {
  /** Overrides the page <title> (and og:title); falls back to the entry's own title via createMetadata's `fallback`. */
  title?: string;
  description?: string;
  /** Absolute https URL or site-relative path — anything else (javascript:, http:, protocol-relative) is rejected by the schema. */
  canonical?: string;
  /** Repo path of the og:image, same convention as fields.image. */
  ogImage?: string | null;
  noindex?: boolean;
}

export interface SeoFieldOptions {
  /** Defaults to "SEO". */
  label?: string;
  /** Enables the og-image upload/browse UI (same media pipeline as fields.image); omit to make ogImage a plain path input. */
  imageDirectory?: string;
}

export interface SeoFieldDefinition extends FieldDefinition<SeoValue> {
  readonly kind: "seo";
  readonly imageDirectory?: string;
}

const canonicalSchema = z
  .string()
  .refine((v) => v.startsWith("https://") || (v.startsWith("/") && !v.startsWith("//")), {
    message: "canonical must be an absolute https:// URL or a site-relative path.",
  });

/**
 * `.strict()` so a typo'd property is rejected, not silently persisted;
 * every property optional so an empty panel stores an empty object. The
 * value round-trips as one nested YAML mapping under the field name.
 */
const seoValueSchema: z.ZodType<SeoValue> = z
  .object({
    title: z.string().max(300).optional(),
    description: z.string().max(1000).optional(),
    canonical: canonicalSchema.optional(),
    ogImage: z
      .string()
      .refine((v) => !v.includes(".."), 'Image path must not contain ".."')
      .nullable()
      .optional(),
    noindex: z.boolean().optional(),
  })
  .strict();

/**
 * A composite per-entry/per-page SEO field group — editable in the admin
 * as a collapsed panel, converted to a Next.js Metadata object with
 * cimisy/seo's createMetadata()/toNextMetadata().
 */
export function seo(options: SeoFieldOptions = {}): SeoFieldDefinition {
  if (options.imageDirectory?.includes("..")) {
    throw new Error(`SEO field imageDirectory must not contain "..".`);
  }
  return {
    kind: "seo",
    label: options.label ?? "SEO",
    location: "frontmatter",
    // An absent field parses as {} rather than failing validation — SEO is
    // always optional metadata, never a reason an entry can't load.
    zodSchema: z.preprocess((v) => v ?? {}, seoValueSchema) as unknown as z.ZodType<SeoValue>,
    imageDirectory: options.imageDirectory,
  };
}
