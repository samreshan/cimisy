"use client";

import { type FormEvent, useEffect, useState } from "react";
import type { SingletonManifest } from "../../next/manifest.js";
import { type PublishResult, apiUrl } from "./api.js";
import { buildSingletonPreviewUrl, FieldsEditor } from "./entry-form.js";
import { HistoryPanel } from "./history.js";

/** The reserved slug singleton drafts/uploads use — mirror of shared/branch-name.ts's SINGLETON_DRAFT_SLUG (not imported: that module is server-side). */
const SINGLETON_SLUG = "singleton";

/**
 * The singleton counterpart of EntryForm: one fixed document, no slug, no
 * delete. A never-saved singleton comes back as `{ singleton: null }` —
 * rendered as an empty "Create" form, so declaring a singleton in config
 * is all it takes for it to become editable.
 */
export function SingletonForm({
  singleton,
  basePath,
  apiBasePath,
}: {
  singleton: SingletonManifest;
  basePath: string;
  apiBasePath: string;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [version, setVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [neverSaved, setNeverSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [draftRef, setDraftRef] = useState<string | undefined>(undefined);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl(apiBasePath, `/singletons/${singleton.key}`))
      .then((res) => res.json())
      .then((data: { singleton: { values: Record<string, unknown>; version: string } | null }) => {
        if (cancelled) return;
        if (data.singleton) {
          setValues(data.singleton.values);
          setVersion(data.singleton.version);
        } else {
          setNeverSaved(true);
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [singleton.key, apiBasePath]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(apiUrl(apiBasePath, `/singletons/${singleton.key}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values, baseVersion: version }),
    });
    const data = (await res.json()) as { version?: string; publish?: PublishResult; error?: string };
    if (!res.ok || !data.version) {
      setError(data.error ?? "Save failed");
      return;
    }
    setVersion(data.version);
    setPublishResult(data.publish ?? null);
    if (data.publish?.status === "draft") setDraftRef(data.publish.branch);
    setNeverSaved(false);
    setDirty(false);
    setPreviewKey((k) => k + 1);
  }

  if (loading) return <p className="cimisy-muted">Loading…</p>;

  const canPreview = Boolean(singleton.previewPath);

  return (
    <div className="cimisy-entry-layout">
      <div className="cimisy-entry-main">
        <form onSubmit={handleSubmit}>
          <a className="cimisy-crumb cimisy-link" href={basePath}>
            &larr; Content
          </a>
          <h1 className="cimisy-heading">{singleton.label}</h1>
          {canPreview && (
            <p>
              <button
                type="button"
                className="cimisy-btn cimisy-btn-secondary"
                onClick={() => setPreviewOpen((o) => !o)}
                style={{ marginBottom: 4 }}
              >
                {previewOpen ? "Hide preview" : "Show preview"}
              </button>
            </p>
          )}
          {neverSaved && <p className="cimisy-muted">Not created yet — fill in the fields and save.</p>}
          {error && <p className="cimisy-banner cimisy-banner-danger">{error}</p>}
          {publishResult?.status === "direct" && <p className="cimisy-banner cimisy-banner-success">Published directly.</p>}
          {publishResult?.status === "draft" && (
            <p className="cimisy-banner cimisy-banner-warning">
              Saved as a draft on branch <code>{publishResult.branch}</code> —{" "}
              <a href={publishResult.pullRequestUrl} target="_blank" rel="noreferrer">
                view pull request &rarr;
              </a>
            </p>
          )}
          <FieldsEditor
            fields={singleton.fields}
            values={values}
            onChange={(fieldName, v) => {
              setValues((prev) => ({ ...prev, [fieldName]: v }));
              setDirty(true);
            }}
            apiBasePath={apiBasePath}
            targetKey={singleton.key}
            slug={SINGLETON_SLUG}
            draftRef={draftRef}
          />
          <button type="submit" className="cimisy-btn cimisy-btn-primary">
            {neverSaved ? "Create" : "Save"}
          </button>
        </form>
        <HistoryPanel historyPath={`/singletons/${singleton.key}/history`} apiBasePath={apiBasePath} />
      </div>
      {canPreview && previewOpen && singleton.previewPath && (
        <div className="cimisy-entry-preview">
          <div className="cimisy-preview-header">
            <span className="cimisy-muted" style={{ fontSize: "0.85em" }}>
              Preview
            </span>
            {dirty && (
              <span className="cimisy-badge" style={{ background: "var(--cimisy-warning-soft)", color: "var(--cimisy-warning)" }}>
                unsaved changes not shown
              </span>
            )}
          </div>
          <iframe
            key={previewKey}
            className="cimisy-preview-iframe"
            title="Preview"
            src={buildSingletonPreviewUrl(apiBasePath, singleton.key, singleton.previewPath)}
          />
        </div>
      )}
    </div>
  );
}
