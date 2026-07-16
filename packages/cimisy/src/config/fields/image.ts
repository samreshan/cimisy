import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export interface ImageFieldOptions {
  label: string;
  /** Repo-relative directory new uploads are written under (upload UI ships in a later milestone; M1 stores a path string). */
  directory: string;
}

export interface ImageFieldDefinition extends FieldDefinition<string | null> {
  readonly kind: "image";
  readonly directory: string;
}

export function image(options: ImageFieldOptions): ImageFieldDefinition {
  if (options.directory.includes("..")) {
    throw new Error(`Image field "${options.label}" directory must not contain "..".`);
  }
  return {
    kind: "image",
    label: options.label,
    location: "frontmatter",
    // .default(null) so an untouched image input (never added to `values`) validates and
    // round-trips as an explicit null instead of writing a file the parse path rejects.
    zodSchema: z
      .string()
      .refine((v) => !v.includes(".."), "Image path must not contain \"..\"")
      .nullable()
      .default(null),
    directory: options.directory,
  };
}
