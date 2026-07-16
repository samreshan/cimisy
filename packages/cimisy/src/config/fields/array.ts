import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export function array<T>(itemField: FieldDefinition<T>): FieldDefinition<T[]> {
  return {
    kind: "array",
    label: itemField.label,
    location: "frontmatter",
    // .default([]) so an untouched list (never added to `values`) validates and round-trips
    // as an explicit empty list instead of writing a file the parse path rejects.
    zodSchema: z.array(itemField.zodSchema).default([]),
  };
}
