import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export interface SelectFieldOptions {
  label: string;
  /** The allowed values, in display order. */
  options: string[];
  validation?: { isRequired?: boolean };
}

export interface SelectFieldDefinition extends FieldDefinition<string> {
  readonly kind: "select";
  readonly options: string[];
  readonly validation?: { isRequired?: boolean };
}

/**
 * One-of-a-fixed-set string field, rendered as a <select>. Not required
 * (the default) additionally admits "" — the "nothing chosen" state, same
 * empty-string convention as text's default.
 */
export function select(options: SelectFieldOptions): SelectFieldDefinition {
  if (options.options.length === 0) {
    throw new Error(`Select field "${options.label}" needs at least one option.`);
  }
  const allowed = options.options;
  const isRequired = options.validation?.isRequired;
  const zodSchema = isRequired
    ? z.string({ error: "Required." }).refine((v) => allowed.includes(v), { message: `Must be one of: ${allowed.join(", ")}.` })
    : z
        .string()
        .refine((v) => v === "" || allowed.includes(v), { message: `Must be one of: ${allowed.join(", ")}.` })
        .default("");
  return {
    kind: "select",
    label: options.label,
    location: "frontmatter",
    zodSchema: zodSchema as z.ZodType<string, unknown>,
    options: allowed,
    validation: options.validation,
  };
}
