import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export interface TextFieldOptions {
  label: string;
  validation?: { isRequired?: boolean; maxLength?: number };
}

export interface TextFieldDefinition extends FieldDefinition<string> {
  readonly kind: "text";
  readonly validation?: { isRequired?: boolean; maxLength?: number };
}

export function text(options: TextFieldOptions): TextFieldDefinition {
  const maxLength = options.validation?.maxLength;
  let schema = options.validation?.isRequired ? z.string({ error: "Required." }) : z.string();
  if (maxLength) schema = schema.max(maxLength, `Must be ${maxLength} characters or fewer.`);
  // A non-required text field defaults to "" so an untouched input (which the
  // admin never adds to `values` at all) validates and round-trips — before
  // this default, such a save produced a file the parse path then rejected.
  const zodSchema = options.validation?.isRequired ? schema.min(1, "Required.") : schema.default("");
  return {
    kind: "text",
    label: options.label,
    location: "frontmatter",
    zodSchema,
    validation: options.validation,
  };
}
