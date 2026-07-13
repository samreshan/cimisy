import { useEffect, useState } from "react";
import type { AdminManifest, CollectionManifest, EntityManifest, ManifestTreeNode } from "../../next/manifest.js";
import { type EntrySummaryLike, apiUrl } from "./api.js";

/**
 * The admin home screen: renders the manifest's content tree — top-level
 * collections/singletons as flat cards, pages as group cards with their
 * sections/collections indented beneath — mirroring how the config (and
 * the site) is actually structured instead of one flat list.
 */
export function ContentTree({ manifest, basePath }: { manifest: AdminManifest; basePath: string }) {
  return (
    <div>
      <h1 className="cimisy-heading">cimisy admin</h1>
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

function TreeNode({ node, basePath }: { node: ManifestTreeNode; basePath: string }) {
  if (node.kind !== "page") {
    return <EntityCard entity={node} basePath={basePath} />;
  }
  return (
    <div className="cimisy-page-group">
      <div className="cimisy-page-group-header">
        <span className="cimisy-page-group-label">{node.label}</span>
        {node.route && <code className="cimisy-muted">{node.route}</code>}
      </div>
      <ul className="cimisy-list cimisy-page-group-children">
        {node.children.map((child) => (
          <li key={child.key}>
            <EntityCard entity={child} basePath={basePath} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function EntityCard({ entity, basePath }: { entity: EntityManifest; basePath: string }) {
  return (
    <a className="cimisy-card" href={`${basePath}/${entity.key}`}>
      {entity.label}
      <span className="cimisy-badge" style={{ marginLeft: 8 }}>
        {entity.kind === "collection" ? "collection" : "content"}
      </span>
    </a>
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
    fetch(apiUrl(apiBasePath, `/collections/${collection.key}`))
      .then((res) => res.json())
      .then((data: { entries: EntrySummaryLike[] }) => {
        if (!cancelled) setEntries(data.entries);
      });
    return () => {
      cancelled = true;
    };
  }, [collection.key, apiBasePath]);

  return (
    <div>
      <a className="cimisy-crumb cimisy-link" href={basePath}>
        &larr; Content
      </a>
      <h1 className="cimisy-heading">{collection.label}</h1>
      <a className="cimisy-btn cimisy-btn-primary" href={`${basePath}/${collection.key}/new`} style={{ marginBottom: 20 }}>
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
                <a className="cimisy-card" href={`${basePath}/${collection.key}/${entry.slug}`}>
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
