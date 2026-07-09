import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export interface TextFieldOptions {
  label: string;
  validation?: { isRequired?: boolean; maxLength?: number };
}

export function text(options: TextFieldOptions): FieldDefinition<string> {
  let schema = z.string();
  if (options.validation?.maxLength) schema = schema.max(options.validation.maxLength);
  const zodSchema = options.validation?.isRequired ? schema.min(1) : schema;
  return {
    kind: "text",
    label: options.label,
    location: "frontmatter",
    zodSchema,
  };
}
