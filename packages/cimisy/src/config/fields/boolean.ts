import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export interface BooleanFieldOptions {
  label: string;
}

export interface BooleanFieldDefinition extends FieldDefinition<boolean> {
  readonly kind: "boolean";
}

/**
 * A real boolean, stored as a YAML boolean — not "true"/"false" strings.
 * This is what removes the scanner's boolean-coercion caveat (see
 * scan/infer-schema.ts): a migrated `{field && <X/>}` check keeps working
 * because the reader hands back an actual boolean.
 */
export function boolean(options: BooleanFieldOptions): BooleanFieldDefinition {
  return {
    kind: "boolean",
    label: options.label,
    location: "frontmatter",
    // .default(false) so an untouched toggle (never added to `values`) validates and
    // round-trips — the same posture as text's .default("").
    zodSchema: z.boolean().default(false),
  };
}
