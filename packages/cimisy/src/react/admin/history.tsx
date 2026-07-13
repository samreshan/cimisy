import { useEffect, useState } from "react";
import { type HistoryEntryLike, apiUrl } from "./api.js";

/** The activity-log UI: surfaces git history for an entry or singleton (see next/route-handler.ts's /history routes — the caller passes the API path, e.g. "/collections/posts/hello/history" or "/singletons/settings/history"). Hides itself when the storage adapter doesn't support history (e.g. the local adapter) rather than showing an empty/broken section. */
export function HistoryPanel({ historyPath, apiBasePath }: { historyPath: string; apiBasePath: string }) {
  const [state, setState] = useState<{ supported: boolean; history: HistoryEntryLike[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl(apiBasePath, historyPath))
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
  }, [historyPath, apiBasePath]);

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
