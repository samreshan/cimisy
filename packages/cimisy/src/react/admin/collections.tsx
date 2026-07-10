import { useEffect, useState } from "react";
import type { AdminManifest, CollectionManifest } from "../../next/manifest.js";
import { type EntrySummaryLike, apiUrl } from "./api.js";

export function CollectionList({ manifest, basePath }: { manifest: AdminManifest; basePath: string }) {
  return (
    <div>
      <h1 className="cimisy-heading">cimisy admin</h1>
      <ul className="cimisy-list">
        {manifest.collections.map((c) => (
          <li key={c.name}>
            <a className="cimisy-card" href={`${basePath}/${c.name}`}>
              {c.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
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

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl(apiBasePath, `/collections/${collection.name}`))
      .then((res) => res.json())
      .then((data: { entries: EntrySummaryLike[] }) => {
        if (!cancelled) setEntries(data.entries);
      });
    return () => {
      cancelled = true;
    };
  }, [collection.name, apiBasePath]);

  return (
    <div>
      <a className="cimisy-crumb cimisy-link" href={basePath}>
        &larr; Collections
      </a>
      <h1 className="cimisy-heading">{collection.label}</h1>
      <a className="cimisy-btn cimisy-btn-primary" href={`${basePath}/${collection.name}/new`} style={{ marginBottom: 20 }}>
        + New
      </a>
      {entries === null ? (
        <p className="cimisy-muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="cimisy-empty">No entries yet.</p>
      ) : (
        <ul className="cimisy-list" style={{ marginTop: 20 }}>
          {entries.map((entry) =>
            entry.error ? (
              <li key={entry.slug}>
                <div className="cimisy-card cimisy-card-error">
                  {entry.slug} — failed to parse: {entry.error}
                </div>
              </li>
            ) : (
              <li key={entry.slug}>
                <a className="cimisy-card" href={`${basePath}/${collection.name}/${entry.slug}`}>
                  {String(entry.values[collection.slugField] ?? entry.slug)}
                </a>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
