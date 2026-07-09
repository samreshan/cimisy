import "server-only";
import type { EntrySummary } from "../content/collection-store.js";
import { listEntries, readEntry } from "../content/collection-store.js";
import type { CimisyConfig } from "../config/define-config.js";
import { getPreviewRef } from "./draft-mode.js";

export interface CollectionReader {
  /** All entries on the current ref — the default branch normally, or the active preview's draft branch when Draft Mode is on. */
  all(): Promise<EntrySummary[]>;
  bySlug(slug: string): Promise<EntrySummary | null>;
}

export interface Reader {
  collections: Record<string, CollectionReader>;
}

/**
 * The public-facing counterpart to the admin API: no auth, no RBAC (this
 * is what renders a site's own pages for any visitor), and draft-mode
 * aware. Every method resolves its ref fresh on each call via
 * getPreviewRef() rather than once at reader construction, since draft
 * mode is a per-request concern (a cookie), not a property of the reader
 * instance — the same reader object is safe to keep around across
 * requests as long as it isn't module-level-cached in a way that outlives
 * a single request's draft-mode state.
 *
 * Reads go through the exact same parseEntry -> assertSafeMdxTree path as
 * the admin API (see content/codec.ts) — a hand-edited malicious file is
 * rejected here too, not just when viewed through the admin UI.
 */
export function createReader(cimisyConfig: CimisyConfig): Reader {
  const collections: Record<string, CollectionReader> = {};
  for (const [name, def] of Object.entries(cimisyConfig.collections)) {
    collections[name] = {
      async all() {
        const ref = await getPreviewRef();
        return listEntries(cimisyConfig.source, def, ref ?? undefined);
      },
      async bySlug(slug: string) {
        const ref = await getPreviewRef();
        return readEntry(cimisyConfig.source, def, slug, ref ?? undefined);
      },
    };
  }
  return { collections };
}
