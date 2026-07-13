import "server-only";
import type { EntrySummary } from "../content/collection-store.js";
import { listEntries, readEntry } from "../content/collection-store.js";
import type { SingletonSnapshot } from "../content/singleton-store.js";
import { readSingleton } from "../content/singleton-store.js";
import type { NormalizedCollection, NormalizedSingleton, ResolvedCimisyConfig } from "../config/define-config.js";
import { getPreviewRef } from "./draft-mode.js";

export interface CollectionReader {
  /** All entries on the current ref — the default branch normally, or the active preview's draft branch when Draft Mode is on. */
  all(): Promise<EntrySummary[]>;
  bySlug(slug: string): Promise<EntrySummary | null>;
}

export interface SingletonReader {
  /** Null when the singleton has never been saved — mirror of the admin API's `{ singleton: null }` contract. */
  get(): Promise<SingletonSnapshot | null>;
}

/** One page's children, keyed by section key: a SingletonReader for section()s, a CollectionReader for nested collection()s. */
export type PageReader = Record<string, CollectionReader | SingletonReader>;

export interface Reader {
  /** Top-level collections only — page-nested ones live under `pages`. */
  collections: Record<string, CollectionReader>;
  /** Top-level singletons only (e.g. site settings). */
  singletons: Record<string, SingletonReader>;
  /** reader.pages.home.hero.get(), reader.pages.home.testimonials.all() */
  pages: Record<string, PageReader>;
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
export function createReader(cimisyConfig: ResolvedCimisyConfig): Reader {
  function collectionReader(def: NormalizedCollection): CollectionReader {
    return {
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

  function singletonReader(def: NormalizedSingleton): SingletonReader {
    return {
      async get() {
        const ref = await getPreviewRef();
        return readSingleton(cimisyConfig.source, def, ref ?? undefined);
      },
    };
  }

  const collections: Record<string, CollectionReader> = {};
  const singletons: Record<string, SingletonReader> = {};
  const pages: Record<string, PageReader> = {};

  for (const node of cimisyConfig.contentTree) {
    if (node.kind === "collection") {
      collections[node.key] = collectionReader(cimisyConfig.collectionsByKey[node.key]!);
    } else if (node.kind === "singleton") {
      singletons[node.key] = singletonReader(cimisyConfig.singletonsByKey[node.key]!);
    } else {
      const children: PageReader = {};
      for (const child of node.children) {
        const sectionKey = child.key.split(".").pop()!;
        children[sectionKey] =
          child.kind === "collection"
            ? collectionReader(cimisyConfig.collectionsByKey[child.key]!)
            : singletonReader(cimisyConfig.singletonsByKey[child.key]!);
      }
      pages[node.key] = children;
    }
  }

  return { collections, singletons, pages };
}
