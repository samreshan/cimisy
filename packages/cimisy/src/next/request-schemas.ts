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

/** Same shape as an entry write (a singleton just has no slug) — kept as its own schema so the two contracts can drift independently. */
export const writeSingletonBodySchema = z.object({
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
 * need the decoded bytes, not just the string shape. `targetKey` (a
 * collection or singleton content key) + `slug` identify which draft
 * branch (or main, for direct-publish roles) the upload should land on —
 * see next/route-handler.ts's resolveWriteRef; singleton editors send
 * the reserved slug "singleton".
 */
export const uploadMediaBodySchema = z.object({
  // Optional (together) since 2.4: the standalone media library screen
  // uploads with no entry context — the route substitutes the reserved
  // "media"/"library" target so draft-role uploads still get a branch.
  targetKey: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  directory: z.string().min(1),
  filename: z.string().min(1).max(255),
  content: z
    .string()
    .min(1)
    .refine((s) => /^[A-Za-z0-9+/]+=*$/.test(s), { message: "content must be base64-encoded." }),
});

/** Body for DELETE /media (the standalone media library's delete action). `baseVersion` is the file version from GET /media — optimistic concurrency, same as entry deletes. */
export const deleteMediaBodySchema = z.object({
  path: z.string().min(1),
  baseVersion: z.string().min(1),
});

/** Body for the dev-only POST /scan route (see route-handler.ts's scan surface). Mode literals mirror scan/modes.ts's SCAN_MODES — duplicated here so this module stays free of scan imports (the scan stack pulls in the TypeScript compiler). */
export const runScanBodySchema = z.object({
  mode: z.enum(["collections", "collections-metadata", "static", "static-metadata"]).optional(),
});

/**
 * Body for the dev-only POST /scan/import route. Selections address
 * candidates by kind + index into the *cached* report's arrays
 * (collectionCandidates / staticContentCandidates / pageMetadataCandidates)
 * — the same identity scheme the CLI's interactive picker uses — so the
 * server only ever applies what its own last scan produced, never a
 * client-supplied candidate object.
 */
export const scanImportBodySchema = z.object({
  selections: z
    .array(
      z.object({
        kind: z.enum(["collection", "static", "metadata"]),
        index: z.number().int().min(0),
      }),
    )
    .min(1),
  allowDirty: z.boolean().optional(),
});

export type WriteEntryBody = z.infer<typeof writeEntryBodySchema>;
export type WriteSingletonBody = z.infer<typeof writeSingletonBodySchema>;
export type DeleteEntryBody = z.infer<typeof deleteEntryBodySchema>;
export type SetUserRoleBody = z.infer<typeof setUserRoleBodySchema>;
export type UploadMediaBody = z.infer<typeof uploadMediaBodySchema>;
