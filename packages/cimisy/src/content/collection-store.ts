import type { CollectionDefinition } from "../config/collection.js";
import type { SlugFieldDefinition } from "../config/fields/slug.js";
import { CimisyError } from "../shared/errors.js";
import { assertSafeSlug, entryPathForSlug, slugify } from "../shared/slug.js";
import type { ChangeAuthor, ChangeResult, StorageAdapter } from "../storage/types.js";
import { parseEntry, serializeEntry } from "./codec.js";

export interface EntrySummary {
  slug: string;
  version: string;
  values: Record<string, unknown>;
  /** Present when this entry failed to parse/validate — e.g. hand-edited outside the UI into an invalid or unsafe state. `values` is empty when this is set. */
  error?: string;
}

/**
 * A single unparseable/unsafe file (hand-edited outside the UI, or just a
 * typo) must not take the whole collection listing down with it — every
 * other entry is still real content someone needs to see and edit. Errors
 * are isolated per-file and surfaced on that entry's summary instead of
 * thrown, so the failure mode for "one bad file" is "one broken row in
 * the list," not "the whole list is unreachable."
 */
export async function listEntries(adapter: StorageAdapter, def: CollectionDefinition, ref?: string): Promise<EntrySummary[]> {
  const files = await adapter.list(def.directory, ref);
  const entries: EntrySummary[] = [];
  for (const file of files) {
    if (!file.path.endsWith(def.extension)) continue;
    const record = await adapter.read(file.path, ref);
    if (!record) continue;
    const slugFromPath = deriveSlugFromPath(file.path, def);
    try {
      const values = parseEntry(def.schema, file.path, record.content);
      const slugValue = String(values[def.slugField] ?? slugFromPath);
      entries.push({ slug: slugValue, version: record.version, values });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cimisy] failed to parse entry "${file.path}":`, message);
      entries.push({ slug: slugFromPath, version: record.version, values: {}, error: message });
    }
  }
  return entries;
}

function deriveSlugFromPath(path: string, def: CollectionDefinition): string {
  const filename = path.slice(def.directory.length + 1);
  return filename.slice(0, filename.length - def.extension.length);
}

export async function readEntry(
  adapter: StorageAdapter,
  def: CollectionDefinition,
  slug: string,
  ref?: string,
): Promise<EntrySummary | null> {
  const path = entryPathForSlug(def.path, slug);
  const record = await adapter.read(path, ref);
  if (!record) return null;
  const values = parseEntry(def.schema, path, record.content);
  return { slug, version: record.version, values };
}

/**
 * Resolves the slug a write will land under, before anything is written —
 * callers that need to decide a target ref/branch based on the slug (see
 * next/route-handler.ts's draft-branch naming) need this available
 * up front, not just as a side effect of writeEntry.
 *
 * Validates the resolved slug before returning it, regardless of which
 * branch produced it: an auto-derived slug (via slugify()) is already
 * safe by construction, but an *explicit* one — whether it came from the
 * URL path or from `values[slugField]` in a request body — is
 * attacker-influenced and must be checked here, not left to whichever
 * downstream call happens to reach entryPathForSlug first. Callers (e.g.
 * next/route-handler.ts) use this resolved-and-validated slug for RBAC
 * permission checks too, so authorization is always evaluated against a
 * real, safe path — never a raw, unvalidated one.
 */
export function resolveEntrySlug(def: CollectionDefinition, values: Record<string, unknown>, explicitSlug?: string): string {
  const slug = explicitSlug ?? (values[def.slugField] as string | undefined);
  if (slug) {
    assertSafeSlug(slug);
    return slug;
  }
  const slugFieldDef = def.schema[def.slugField] as SlugFieldDefinition;
  const sourceValue = values[slugFieldDef.source];
  if (typeof sourceValue !== "string" || sourceValue.length === 0) {
    throw new CimisyError(`Cannot derive slug: field "${slugFieldDef.source}" has no value.`, "SLUG_DERIVATION_FAILED");
  }
  return slugify(sourceValue);
}

export interface WriteEntryInput {
  /** Existing entry's slug when updating; omit to derive/assign one for a new entry. */
  slug?: string;
  values: Record<string, unknown>;
  baseVersion: string | null;
  author: ChangeAuthor;
  message: string;
  ref: string;
}

export async function writeEntry(
  adapter: StorageAdapter,
  def: CollectionDefinition,
  input: WriteEntryInput,
): Promise<{ result: ChangeResult; slug: string }> {
  const slug = resolveEntrySlug(def, input.values, input.slug);
  const values = { ...input.values, [def.slugField]: slug };
  const content = serializeEntry(def.schema, values);
  const path = entryPathForSlug(def.path, slug);
  const result = await adapter.commitChange({
    ref: input.ref,
    baseVersion: input.baseVersion,
    message: input.message,
    author: input.author,
    writes: [{ path, content }],
  });
  return { result, slug };
}

export interface DeleteEntryInput {
  baseVersion: string | null;
  author: ChangeAuthor;
  message: string;
  ref: string;
}

export async function deleteEntry(
  adapter: StorageAdapter,
  def: CollectionDefinition,
  slug: string,
  input: DeleteEntryInput,
): Promise<ChangeResult> {
  const path = entryPathForSlug(def.path, slug);
  return adapter.commitChange({
    ref: input.ref,
    baseVersion: input.baseVersion,
    message: input.message,
    author: input.author,
    writes: [],
    deletes: [path],
  });
}
