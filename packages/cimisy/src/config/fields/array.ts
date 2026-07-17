import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export interface ArrayFieldDefinition<T = unknown> extends FieldDefinition<T[]> {
  readonly kind: "array";
  /** The wrapped item field — kept so the manifest can tell the admin UI what kind of input each item needs (see next/manifest.ts). */
  readonly itemField: FieldDefinition<T>;
}

export function array<T>(itemField: FieldDefinition<T>): ArrayFieldDefinition<T> {
  return {
    kind: "array",
    label: itemField.label,
    location: "frontmatter",
    // .default([]) so an untouched list (never added to `values`) validates and round-trips
    // as an explicit empty list instead of writing a file the parse path rejects.
    zodSchema: z.array(itemField.zodSchema).default([]),
    itemField,
  };
}
