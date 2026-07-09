import { z } from "zod";

/**
 * Every external request body is validated against one of these before
 * any field of it is used — no `as` casts on `request.json()` output
 * anywhere in the admin API. `.record(z.unknown())` deliberately leaves
 * per-field validation to each field's own zod schema (see
 * config/fields/*.ts) rather than duplicating it here; this layer's job
 * is only to guarantee the request has the *shape* the handler assumes
 * (an object, not a string/array/null) before it's passed further in.
 */
export const writeEntryBodySchema = z.object({
  values: z.record(z.unknown()),
  baseVersion: z.string().nullable().optional(),
});

export const deleteEntryBodySchema = z.object({
  baseVersion: z.string().nullable().optional(),
});

export type WriteEntryBody = z.infer<typeof writeEntryBodySchema>;
export type DeleteEntryBody = z.infer<typeof deleteEntryBodySchema>;
