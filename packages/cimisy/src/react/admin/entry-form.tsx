"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import type { CollectionManifest, FieldManifest } from "../../next/manifest.js";
import { type EntrySummaryLike, type PublishResult, apiUrl } from "./api.js";
import { TiptapBlockEditor } from "./editor/block-editor.js";
import { HistoryPanel } from "./history.js";
import { ImageField } from "./image-field.js";
import { SeoPanel } from "./seo-panel.js";

export function buildPreviewUrl(apiBasePath: string, contentKey: string, slug: string, previewPath: string, ref?: string): string {
  const redirectTo = previewPath.replace(":slug", encodeURIComponent(slug));
  const params = new URLSearchParams({ collection: contentKey, slug, redirectTo, ...(ref ? { ref } : {}) });
  return `${apiBasePath}/preview/enable?${params.toString()}`;
}

/** Singleton counterpart of buildPreviewUrl: no slug (the previewPath is a fixed route), `singleton=<key>` instead of `collection+slug`. */
export function buildSingletonPreviewUrl(apiBasePath: string, contentKey: string, previewPath: string, ref?: string): string {
  const params = new URLSearchParams({ singleton: contentKey, redirectTo: previewPath, ...(ref ? { ref } : {}) });
  return `${apiBasePath}/preview/enable?${params.toString()}`;
}

/**
 * The field-rendering core shared by EntryForm (collection entries) and
 * SingletonForm (singletons/sections) — everything from `values` down to
 * the per-kind inputs, with no knowledge of where the values get saved.
 * `targetKey` + `slug` identify the draft branch uploads should land on
 * (see route-handler.ts's resolveWriteRef); singleton editors pass the
 * reserved slug "singleton".
 */
export function FieldsEditor({
  fields,
  values,
  onChange,
  apiBasePath,
  targetKey,
  slug,
  draftRef,
}: {
  fields: FieldManifest[];
  values: Record<string, unknown>;
  onChange: (fieldName: string, value: unknown) => void;
  apiBasePath: string;
  targetKey: string;
  slug: string | null;
  draftRef?: string;
}) {
  return (
    <>
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={values[field.name]}
          onChange={(v) => onChange(field.name, v)}
          apiBasePath={apiBasePath}
          targetKey={targetKey}
          slug={slug}
          draftRef={draftRef}
        />
      ))}
    </>
  );
}

export function EntryForm({
  collection,
  slug,
  basePath,
  apiBasePath,
}: {
  collection: CollectionManifest;
  slug: string | null;
  basePath: string;
  apiBasePath: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [version, setVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(slug !== null);
  const [error, setError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  // Mirrors whatever branch the entry is currently saved on, so an image
  // field's thumbnails (via /media/raw) resolve against the right ref for
  // content that only exists on an undeployed draft branch.
  const [draftRef, setDraftRef] = useState<string | undefined>(undefined);
  // Live preview pane (M7): shows the *last saved* state, not live
  // unsaved edits — reloading the whole consuming site's page for every
  // keystroke isn't practical, so `dirty` exists to make that boundary
  // honest rather than surprising. `previewKey` is bumped on every
  // successful save to force the iframe to reload (its `src` alone
  // wouldn't change across saves of the same entry).
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  useEffect(() => {
    if (!slug) return;
    fetch(apiUrl(apiBasePath, `/collections/${collection.key}/${slug}`))
      .then((res) => res.json())
      .then((data: { entry: EntrySummaryLike }) => {
        setValues(data.entry.values);
        setVersion(data.entry.version);
        setLoading(false);
      });
  }, [collection.key, slug, apiBasePath]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(apiUrl(apiBasePath, `/collections/${collection.key}${slug ? `/${slug}` : ""}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values, baseVersion: version }),
    });
    const data = (await res.json()) as { slug?: string; version?: string; publish?: PublishResult; error?: string };
    if (!res.ok || !data.slug) {
      setError(data.error ?? "Save failed");
      return;
    }
    setVersion(data.version ?? null);
    setPublishResult(data.publish ?? null);
    if (data.publish?.status === "draft") setDraftRef(data.publish.branch);
    setDirty(false);
    setPreviewKey((k) => k + 1);
    router.push(`${basePath}/${collection.key}/${data.slug}`);
    router.refresh();
  }

  if (loading) return <p className="cimisy-muted">Loading…</p>;

  const canPreview = Boolean(slug && collection.previewPath);

  return (
    <div className="cimisy-entry-layout">
      <div className="cimisy-entry-main">
        <form onSubmit={handleSubmit}>
          <a className="cimisy-crumb cimisy-link" href={`${basePath}/${collection.key}`}>
            &larr; {collection.label}
          </a>
          <h1 className="cimisy-heading">{slug ?? "New entry"}</h1>
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
            fields={collection.fields}
            values={values}
            onChange={(fieldName, v) => {
              setValues((prev) => ({ ...prev, [fieldName]: v }));
              setDirty(true);
            }}
            apiBasePath={apiBasePath}
            targetKey={collection.key}
            slug={slug}
            draftRef={draftRef}
          />
          <button type="submit" className="cimisy-btn cimisy-btn-primary">
            Save
          </button>
        </form>
        {slug && (
          <HistoryPanel historyPath={`/collections/${collection.key}/${slug}/history`} apiBasePath={apiBasePath} />
        )}
      </div>
      {canPreview && previewOpen && slug && collection.previewPath && (
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
            src={buildPreviewUrl(apiBasePath, collection.key, slug, collection.previewPath)}
          />
        </div>
      )}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  apiBasePath,
  targetKey,
  slug,
  draftRef,
}: {
  field: FieldManifest;
  value: unknown;
  onChange: (value: unknown) => void;
  apiBasePath: string;
  targetKey: string;
  slug: string | null;
  draftRef?: string;
}) {
  if (field.kind === "blocks") {
    // Keyed by entry identity (not just field.name, which is stable across
    // a slug change): Tiptap owns its document uncontrolled after mount
    // (see block-editor.tsx's doc comment), so switching which entry is
    // being edited must remount the editor rather than try to resync a
    // live document.
    return (
      <TiptapBlockEditor
        key={`${targetKey}:${slug ?? "new"}`}
        field={field}
        value={value}
        onChange={onChange}
        apiBasePath={apiBasePath}
        draftRef={draftRef}
      />
    );
  }
  if (field.kind === "image") {
    return (
      <ImageField
        field={field}
        value={value}
        onChange={onChange}
        apiBasePath={apiBasePath}
        targetKey={targetKey}
        slug={slug}
        draftRef={draftRef}
      />
    );
  }
  if (field.kind === "seo") {
    return (
      <SeoPanel
        field={field}
        value={value}
        onChange={onChange}
        apiBasePath={apiBasePath}
        targetKey={targetKey}
        slug={slug}
        draftRef={draftRef}
      />
    );
  }
  if (field.kind === "date") {
    const dateValue = typeof value === "string" ? value.slice(0, 10) : "";
    return (
      <div className="cimisy-field">
        <label className="cimisy-label" htmlFor={field.name}>
          {field.label}
        </label>
        <input
          id={field.name}
          className="cimisy-input"
          type="date"
          value={dateValue}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : "")}
        />
      </div>
    );
  }
  return (
    <div className="cimisy-field">
      <label className="cimisy-label" htmlFor={field.name}>
        {field.label}
      </label>
      <input
        id={field.name}
        className="cimisy-input"
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
