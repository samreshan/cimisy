import type { z } from "zod";

/**
 * Every field lives either in the YAML frontmatter block or in the MDX
 * body. This split is what lets the content codec (src/content/codec.ts)
 * serialize/parse a record without each field needing to know about MDX.
 */
export type FieldLocation = "frontmatter" | "body";

export interface FieldDefinition<T = unknown> {
  readonly kind: string;
  readonly label: string;
  readonly location: FieldLocation;
  /** Input is `unknown` (not `T`) so schemas with `.default(...)` — whose input type is `T | undefined` — remain assignable; the parsed output is still `T`. */
  readonly zodSchema: z.ZodType<T, unknown>;
}

export type InferField<F> = F extends FieldDefinition<infer T> ? T : never;
