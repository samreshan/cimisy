import { z } from "zod";
import { UnsafePathError } from "../../shared/errors.js";
import { assertSafeSlug } from "../../shared/slug.js";
import type { FieldDefinition } from "./types.js";

export interface SlugFieldOptions {
  /** Name of the sibling field this slug is auto-derived from when left blank. */
  source: string;
}

export interface SlugFieldDefinition extends FieldDefinition<string> {
  readonly kind: "slug";
  readonly source: string;
}

const slugZodSchema = z.string().superRefine((value, ctx) => {
  try {
    assertSafeSlug(value);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err.message });
    } else {
      throw err;
    }
  }
});

export function slug(options: SlugFieldOptions): SlugFieldDefinition {
  return {
    kind: "slug",
    label: "Slug",
    location: "frontmatter",
    zodSchema: slugZodSchema,
    source: options.source,
  };
}
