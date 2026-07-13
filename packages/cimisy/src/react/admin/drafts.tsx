"use client";

import { useEffect, useState } from "react";
import type { AdminManifest } from "../../next/manifest.js";
import { apiUrl } from "./api.js";
import { buildPreviewUrl, buildSingletonPreviewUrl } from "./entry-form.js";

interface DraftLike {
  id: string;
  title: string;
  url: string;
  state: "open" | "closed";
  updatedAt: string;
  author?: string;
  kind: "collection" | "singleton";
  contentKey: string;
  slug: string;
  branch: string;
  canMerge: boolean;
}

/**
 * The in-CMS review loop: lists open drafts the viewer either authored or
 * can review (see route-handler.ts's handleDraftsList — visibility and
 * `canMerge` are both server-decided, this component just renders what it
 * gets back), with a Preview link (via the draft-branch-aware
 * /preview/enable?ref=) and an Approve & merge action for reviewers.
 */
export function DraftsPage({ manifest, basePath, apiBasePath }: { manifest: AdminManifest; basePath: string; apiBasePath: string }) {
  const [drafts, setDrafts] = useState<DraftLike[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergingId, setMergingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl(apiBasePath, "/drafts"))
      .then(async (res) => {
        const data = (await res.json()) as { drafts?: DraftLike[]; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "Failed to load drafts.");
          return;
        }
        setDrafts(data.drafts ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load drafts.");
      });
    return () => {
      cancelled = true;
    };
  }, [apiBasePath]);

  async function handleMerge(id: string) {
    setError(null);
    setMergingId(id);
    const res = await fetch(apiUrl(apiBasePath, `/drafts/${id}/merge`), { method: "POST" });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    setMergingId(null);
    if (!res.ok) {
      setError(data.error ?? "Merge failed.");
      return;
    }
    setDrafts((prev) => prev?.filter((d) => d.id !== id) ?? null);
  }

  return (
    <div>
      <a className="cimisy-crumb cimisy-link" href={basePath}>
        &larr; Content
      </a>
      <h1 className="cimisy-heading">Drafts</h1>
      {error && <p className="cimisy-banner cimisy-banner-danger">{error}</p>}
      {drafts === null ? (
        <p className="cimisy-muted">Loading…</p>
      ) : drafts.length === 0 ? (
        <p className="cimisy-empty">No open drafts.</p>
      ) : (
        <ul className="cimisy-list">
          {drafts.map((d) => {
            const previewPath = manifest.byKey[d.contentKey]?.previewPath;
            const previewUrl = previewPath
              ? d.kind === "singleton"
                ? buildSingletonPreviewUrl(apiBasePath, d.contentKey, previewPath, d.branch)
                : buildPreviewUrl(apiBasePath, d.contentKey, d.slug, previewPath, d.branch)
              : null;
            return (
              <li key={d.id}>
                <div className="cimisy-card cimisy-team-card">
                  <div>
                    <div className="cimisy-team-name">{d.title}</div>
                    <div className="cimisy-muted" style={{ fontSize: "0.85em" }}>
                      {d.author ? `@${d.author} — ` : ""}
                      {d.kind === "singleton" ? d.contentKey : `${d.contentKey}/${d.slug}`}
                    </div>
                  </div>
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {previewUrl && (
                      <a className="cimisy-btn cimisy-btn-secondary" href={previewUrl}>
                        Preview
                      </a>
                    )}
                    <a className="cimisy-btn cimisy-btn-ghost" href={d.url} target="_blank" rel="noreferrer">
                      View PR
                    </a>
                    {d.canMerge && (
                      <button
                        type="button"
                        className="cimisy-btn cimisy-btn-primary"
                        disabled={mergingId === d.id}
                        onClick={() => handleMerge(d.id)}
                      >
                        {mergingId === d.id ? "Merging…" : "Approve & merge"}
                      </button>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
