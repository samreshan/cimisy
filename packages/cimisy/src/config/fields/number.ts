import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export interface NumberFieldOptions {
  label: string;
  validation?: { isRequired?: boolean; min?: number; max?: number };
}

export interface NumberFieldDefinition extends FieldDefinition<number | null> {
  readonly kind: "number";
  readonly validation?: { isRequired?: boolean; min?: number; max?: number };
}

/** A real number, stored as a YAML number. Optional (the default) admits null — "no value" for a number has no natural sentinel the way "" does for text. */
export function number(options: NumberFieldOptions): NumberFieldDefinition {
  const { isRequired, min, max } = options.validation ?? {};
  let base = z.number({ error: isRequired ? "Required." : "Must be a number." });
  if (min !== undefined) base = base.min(min, `Must be at least ${min}.`);
  if (max !== undefined) base = base.max(max, `Must be at most ${max}.`);
  const zodSchema = isRequired ? base : base.nullable().default(null);
  return {
    kind: "number",
    label: options.label,
    location: "frontmatter",
    zodSchema: zodSchema as z.ZodType<number | null, unknown>,
    validation: options.validation,
  };
}
