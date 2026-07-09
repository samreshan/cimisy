import { z } from "zod";
import type { FieldDefinition } from "./types.js";

export interface DateFieldOptions {
  label: string;
}

export function date(options: DateFieldOptions): FieldDefinition<Date> {
  return {
    kind: "date",
    label: options.label,
    location: "frontmatter",
    zodSchema: z.coerce.date(),
  };
}
