import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export function array<T>(itemField: FieldDefinition<T>): FieldDefinition<T[]> {
  return {
    kind: "array",
    label: itemField.label,
    location: "frontmatter",
    zodSchema: z.array(itemField.zodSchema),
  };
}
