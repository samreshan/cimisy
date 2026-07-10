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
  values: z.record(z.string(), z.unknown()),
  baseVersion: z.string().nullable().optional(),
});

export const deleteEntryBodySchema = z.object({
  baseVersion: z.string().nullable().optional(),
});

/** `role: null` revokes access (back to pending) rather than deleting the roster entry — see rbac/user-store.ts. */
export const setUserRoleBodySchema = z.object({
  githubId: z.string(),
  role: z.string().nullable(),
});

/**
 * `content` is validated only as "a non-empty string that looks like
 * base64" here — the real content/format/size checks (magic-byte sniff,
 * 5MB cap) happen in content/media.ts's decodeUploadedImage, since those
 * need the decoded bytes, not just the string shape. `slug` identifies
 * which entry's draft branch (or main, for direct-publish roles) the
 * upload should land on — see next/route-handler.ts's resolveWriteRef.
 */
export const uploadMediaBodySchema = z.object({
  collectionName: z.string().min(1),
  slug: z.string().min(1),
  directory: z.string().min(1),
  filename: z.string().min(1).max(255),
  content: z
    .string()
    .min(1)
    .refine((s) => /^[A-Za-z0-9+/]+=*$/.test(s), { message: "content must be base64-encoded." }),
});

export type WriteEntryBody = z.infer<typeof writeEntryBodySchema>;
export type DeleteEntryBody = z.infer<typeof deleteEntryBodySchema>;
export type SetUserRoleBody = z.infer<typeof setUserRoleBodySchema>;
export type UploadMediaBody = z.infer<typeof uploadMediaBodySchema>;
