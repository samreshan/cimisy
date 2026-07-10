import { useEffect, useState } from "react";
import type { CollectionManifest } from "../../next/manifest.js";
import { type HistoryEntryLike, apiUrl } from "./api.js";

/** The activity-log UI: surfaces git history for an entry (see next/route-handler.ts's /history route). Hides itself when the storage adapter doesn't support history (e.g. the local adapter) rather than showing an empty/broken section. */
export function HistoryPanel({ collection, slug, apiBasePath }: { collection: CollectionManifest; slug: string; apiBasePath: string }) {
  const [state, setState] = useState<{ supported: boolean; history: HistoryEntryLike[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl(apiBasePath, `/collections/${collection.name}/${slug}/history`))
      .then((res) => res.json())
      .then((data: { supported: boolean; history: HistoryEntryLike[] }) => {
        if (!cancelled) setState(data);
      })
      .catch(() => {
        if (!cancelled) setState({ supported: false, history: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [collection.name, slug, apiBasePath]);

  if (!state?.supported) return null;

  return (
    <div className="cimisy-panel">
      <h2 className="cimisy-subheading">History</h2>
      {state.history.length === 0 ? (
        <p className="cimisy-muted">No history yet.</p>
      ) : (
        <div>
          {state.history.map((entry) => (
            <div key={entry.version} className="cimisy-history-item">
              <code>{entry.version.slice(0, 7)}</code> {entry.message} — {entry.author.name},{" "}
              {new Date(entry.date).toLocaleString()}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
