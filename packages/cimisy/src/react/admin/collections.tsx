import { useEffect, useMemo, useState } from "react";
import type { AdminManifest, CollectionManifest, EntityManifest, ManifestTreeNode } from "../../next/manifest.js";
import { type EntrySummaryLike, apiUrl } from "./api.js";

/**
 * The admin home screen: renders the manifest's content tree — top-level
 * collections/singletons as flat cards, pages as group cards with their
 * sections/collections indented beneath — mirroring how the config (and
 * the site) is actually structured instead of one flat list. With no
 * content configured at all it becomes a getting-started state instead of
 * an empty list.
 */
export function ContentTree({
  manifest,
  basePath,
  apiBasePath,
}: {
  manifest: AdminManifest;
  basePath: string;
  apiBasePath?: string;
}) {
  const scanHint = useScanHint(manifest.scanSupported ? apiBasePath : undefined);
  if (manifest.tree.length === 0) {
    return (
      <div>
        <h1 className="cimisy-heading">cimisy admin</h1>
        <div className="cimisy-empty-state">
          <p className="cimisy-empty-state-title">No content configured yet</p>
          <p className="cimisy-muted" style={{ margin: 0 }}>
            Declare a collection, singleton, or page in <code>cimisy.config.ts</code> and it appears here.
            {manifest.scanSupported && <> Or let the scanner find hardcoded content to import.</>}
          </p>
          {manifest.scanSupported && (
            <a className="cimisy-btn cimisy-btn-primary" href={`${basePath}/scan`}>
              Scan this project &rarr;
            </a>
          )}
        </div>
      </div>
    );
  }
  return (
    <div>
      <h1 className="cimisy-heading">cimisy admin</h1>
      {scanHint && (
        <p className="cimisy-banner cimisy-banner-warning" role="status">
          The last scan found {scanHint.count} importable piece{scanHint.count === 1 ? "" : "s"} of hardcoded content
          {scanHint.routes.length > 0 && <> on {scanHint.routes.slice(0, 3).join(", ")}{scanHint.routes.length > 3 ? ", …" : ""}</>}.{" "}
          <a className="cimisy-link" href={`${basePath}/scan`}>
            Review &amp; import &rarr;
          </a>
        </p>
      )}
      <ul className="cimisy-list">
        {manifest.tree.map((node) => (
          <li key={node.key}>
            <TreeNode node={node} basePath={basePath} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Dev-only onboarding nudge: reads the *cached* scan report (never triggers
 * a scan on its own) and reports how much importable hardcoded content the
 * last scan saw. Silent — no banner, no error — in every failure mode: not
 * dev, no cache yet, or the fetch failing.
 */
function useScanHint(apiBasePath: string | undefined): { count: number; routes: string[] } | null {
  const [hint, setHint] = useState<{ count: number; routes: string[] } | null>(null);

  useEffect(() => {
    if (!apiBasePath) return;
    let cancelled = false;
    fetch(apiUrl(apiBasePath, "/scan/report"))
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          report?: {
            collectionCandidates?: Array<{ usedOnRoutes?: string[] }>;
            staticContentCandidates?: Array<{ usedOnRoutes?: string[] }>;
            pageMetadataCandidates?: Array<{ routePath?: string; pageKey?: string }>;
          } | null;
        };
        const report = data.report;
        if (!report || cancelled) return;
        const collections = report.collectionCandidates ?? [];
        const statics = report.staticContentCandidates ?? [];
        const metadata = (report.pageMetadataCandidates ?? []).filter((c) => c.pageKey);
        const count = collections.length + statics.length + metadata.length;
        if (count === 0) return;
        const routes = new Set<string>();
        for (const c of [...collections, ...statics]) for (const r of c.usedOnRoutes ?? []) routes.add(r);
        for (const c of metadata) if (c.routePath) routes.add(c.routePath);
        setHint({ count, routes: [...routes] });
      })
      .catch(() => {
        // silent by design
      });
    return () => {
      cancelled = true;
    };
  }, [apiBasePath]);

  return hint;
}

function TreeNode({ node, basePath }: { node: ManifestTreeNode; basePath: string }) {
  if (node.kind !== "page") {
    return <EntityCard entity={node} basePath={basePath} />;
  }
  const staticChildren = node.children.filter((child) => child.kind !== "collection");
  const collectionChildren = node.children.filter((child) => child.kind === "collection");
  return (
    <div className="cimisy-page-group">
      <div className="cimisy-page-group-header">
        <span className="cimisy-page-group-label">{node.label}</span>
        {node.route && <code className="cimisy-muted">{node.route}</code>}
      </div>
      {staticChildren.length > 0 && (
        <div className="cimisy-page-group-section">
          <span className="cimisy-page-group-section-label">Static content</span>
          <ul className="cimisy-list cimisy-page-group-children">
            {staticChildren.map((child) => (
              <li key={child.key}>
                <EntityCard entity={child} basePath={basePath} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {collectionChildren.length > 0 && (
        <div className="cimisy-page-group-section">
          <span className="cimisy-page-group-section-label">Collections</span>
          <ul className="cimisy-list cimisy-page-group-children">
            {collectionChildren.map((child) => (
              <li key={child.key}>
                <EntityCard entity={child} basePath={basePath} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EntityCard({ entity, basePath }: { entity: EntityManifest; basePath: string }) {
  const fieldCount = entity.fields.length;
  return (
    <a className="cimisy-card cimisy-entity-card" href={`${basePath}/${entity.key}`}>
      <span className="cimisy-entity-card-title">{entity.label}</span>
      <span className="cimisy-entity-card-meta">
        <span className="cimisy-muted" style={{ fontSize: "0.82em" }}>
          {fieldCount} field{fieldCount === 1 ? "" : "s"}
        </span>
        <span className="cimisy-badge">{entity.kind === "collection" ? "collection" : "static"}</span>
      </span>
    </a>
  );
}

const PAGE_SIZE = 25;

type SortOrder = "title-asc" | "title-desc" | "slug-asc";

/** The visible label an entry sorts/searches by — the slug-source field's value, falling back to the slug itself (same fallback the card renders). */
function entryTitle(entry: EntrySummaryLike, slugField: string): string {
  return String(entry.values[slugField] ?? entry.slug);
}

export function filterAndSortEntries(
  entries: EntrySummaryLike[],
  slugField: string,
  query: string,
  order: SortOrder,
): EntrySummaryLike[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? entries.filter((e) => entryTitle(e, slugField).toLowerCase().includes(q) || e.slug.toLowerCase().includes(q))
    : [...entries];
  filtered.sort((a, b) => {
    if (order === "slug-asc") return a.slug.localeCompare(b.slug);
    const cmp = entryTitle(a, slugField).localeCompare(entryTitle(b, slugField));
    return order === "title-desc" ? -cmp : cmp;
  });
  return filtered;
}

export function EntryList({
  collection,
  basePath,
  apiBasePath,
}: {
  collection: CollectionManifest;
  basePath: string;
  apiBasePath: string;
}) {
  const [entries, setEntries] = useState<EntrySummaryLike[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<SortOrder>("title-asc");
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setEntries(null);
    fetch(apiUrl(apiBasePath, `/collections/${collection.key}`))
      .then(async (res) => {
        const data = (await res.json()) as { entries?: EntrySummaryLike[]; error?: string };
        if (cancelled) return;
        if (!res.ok || !Array.isArray(data.entries)) {
          setError(data.error ?? "Failed to load entries.");
          return;
        }
        setEntries(data.entries);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load entries.");
      });
    return () => {
      cancelled = true;
    };
  }, [collection.key, apiBasePath, reloadKey]);

  const visible = useMemo(
    () => (entries ? filterAndSortEntries(entries, collection.slugField, query, order) : []),
    [entries, collection.slugField, query, order],
  );
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = visible.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  return (
    <div>
      <a className="cimisy-crumb cimisy-link" href={basePath}>
        &larr; Content
      </a>
      <h1 className="cimisy-heading">{collection.label}</h1>
      <a className="cimisy-btn cimisy-btn-primary" href={`${basePath}/${collection.key}/new`} style={{ marginBottom: 20 }}>
        + New
      </a>
      {error ? (
        <div className="cimisy-banner cimisy-banner-danger" role="alert">
          {error}{" "}
          <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </button>
        </div>
      ) : entries === null ? (
        <div className="cimisy-skeleton-stack" role="status" aria-label="Loading entries">
          <div className="cimisy-skeleton cimisy-skeleton-card" />
          <div className="cimisy-skeleton cimisy-skeleton-card" />
          <div className="cimisy-skeleton cimisy-skeleton-card" />
        </div>
      ) : entries.length === 0 ? (
        <div className="cimisy-empty-state">
          <p className="cimisy-empty-state-title">No entries yet</p>
          <p className="cimisy-muted" style={{ margin: 0 }}>
            Everything in {collection.label} will be listed here.
          </p>
          <a className="cimisy-btn cimisy-btn-primary" href={`${basePath}/${collection.key}/new`}>
            Create the first entry &rarr;
          </a>
        </div>
      ) : (
        <>
          {/* Search/sort only appear once there's something to search — a 3-entry list doesn't need chrome. */}
          {entries.length > 5 && (
            <div className="cimisy-list-controls">
              <input
                className="cimisy-input"
                type="search"
                placeholder={`Search ${collection.label.toLowerCase()}…`}
                aria-label={`Search ${collection.label}`}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
              <select
                className="cimisy-select"
                style={{ width: "auto" }}
                aria-label="Sort order"
                value={order}
                onChange={(e) => setOrder(e.target.value as SortOrder)}
              >
                <option value="title-asc">Title A–Z</option>
                <option value="title-desc">Title Z–A</option>
                <option value="slug-asc">Slug A–Z</option>
              </select>
            </div>
          )}
          {visible.length === 0 ? (
            <p className="cimisy-empty">No entries match &quot;{query}&quot;.</p>
          ) : (
            <ul className="cimisy-list" style={{ marginTop: 12 }}>
              {pageItems.map((entry) =>
                entry.error ? (
                  <li key={entry.slug}>
                    <div className="cimisy-card cimisy-card-error">
                      {entry.slug} — failed to parse: {entry.error}
                    </div>
                  </li>
                ) : (
                  <li key={entry.slug}>
                    <a className="cimisy-card" href={`${basePath}/${collection.key}/${entry.slug}`}>
                      {entryTitle(entry, collection.slugField)}
                    </a>
                  </li>
                ),
              )}
            </ul>
          )}
          {pageCount > 1 && (
            <nav className="cimisy-pagination" aria-label="Entry pages">
              <button
                type="button"
                className="cimisy-btn cimisy-btn-secondary"
                disabled={clampedPage === 0}
                onClick={() => setPage(clampedPage - 1)}
              >
                &larr; Previous
              </button>
              <span className="cimisy-muted" style={{ fontSize: "0.85em" }}>
                Page {clampedPage + 1} of {pageCount} · {visible.length} entr{visible.length === 1 ? "y" : "ies"}
              </span>
              <button
                type="button"
                className="cimisy-btn cimisy-btn-secondary"
                disabled={clampedPage >= pageCount - 1}
                onClick={() => setPage(clampedPage + 1)}
              >
                Next &rarr;
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
