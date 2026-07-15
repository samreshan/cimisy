"use client";

import { useRouter } from "next/navigation";
import { Fragment, type FormEvent, useEffect, useState } from "react";
import type { CollectionManifest, FieldManifest } from "../../next/manifest.js";
import { type EntrySummaryLike, type PublishResult, apiUrl } from "./api.js";
import { ArrayField } from "./array-field.js";
import { TiptapBlockEditor } from "./editor/block-editor.js";
import { HistoryPanel } from "./history.js";
import { ImageField } from "./image-field.js";
import { SeoPanel } from "./seo-panel.js";

/** A `cimisy / {segment} / .../ {here}` header — the reference layout's stand-in for a page
 * heading: the last segment (no href) carries the current entry, everything before it is a
 * clickable trail back to the content tree. Used by both EntryForm and SingletonForm. */
export function Breadcrumb({ basePath, trail }: { basePath: string; trail: { label: string; href?: string }[] }) {
  return (
    <nav className="cimisy-crumb-trail" aria-label="Breadcrumb">
      <a href={basePath}>cimisy</a>
      {trail.map((segment, index) => (
        <Fragment key={`${segment.label}-${index}`}>
          <span className="cimisy-crumb-trail-sep">/</span>
          {segment.href ? (
            <a href={segment.href}>{segment.label}</a>
          ) : (
            <span className="cimisy-crumb-trail-here">{segment.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}

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
  titleField,
}: {
  fields: FieldManifest[];
  values: Record<string, unknown>;
  onChange: (fieldName: string, value: unknown) => void;
  apiBasePath: string;
  targetKey: string;
  slug: string | null;
  draftRef?: string;
  /** Name of the field to render as the large, borderless hero title (see FieldInput's `isTitle`
   * branch) — EntryForm passes its collection's first text field; singletons have no equivalent
   * notion of "the" title, so SingletonForm omits it. */
  titleField?: string;
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
          isTitle={field.name === titleField}
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
  // Distinct from `error` (a failed *save*, shown inline above a fillable form that still has
  // real values in it): a failed *load* means `values`/`version` never got populated, so the
  // form can't be shown at all — submitting it would overwrite the real file with blanks.
  const [loadError, setLoadError] = useState<string | null>(null);
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
    let cancelled = false;
    fetch(apiUrl(apiBasePath, `/collections/${collection.key}/${slug}`))
      .then(async (res) => {
        const data = (await res.json()) as { entry?: EntrySummaryLike; error?: string };
        if (cancelled) return;
        if (!res.ok || !data.entry) {
          setLoadError(data.error ?? "Failed to load this entry.");
          setLoading(false);
          return;
        }
        setValues(data.entry.values);
        setVersion(data.entry.version);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError("Failed to load this entry.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
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

  // A dead end, not a fillable form: `values`/`version` never got populated, so rendering the
  // form here would let a Save silently overwrite the real file's fields with blanks.
  if (loadError) {
    return (
      <div>
        <Breadcrumb
          basePath={basePath}
          trail={[{ label: collection.label, href: `${basePath}/${collection.key}` }, { label: slug ?? "New entry" }]}
        />
        <p className="cimisy-banner cimisy-banner-danger">{loadError}</p>
      </div>
    );
  }

  const canPreview = Boolean(slug && collection.previewPath);
  // Best-effort guess at "the title": the first plain-text field. `collection.slugField` looks
  // tempting but names the field the *URL* is derived from, which is often a separate, auto-
  // generated fields.slug() (kind "slug") rather than the human-facing title (kind "text").
  const titleFieldName = collection.fields.find((f) => f.kind === "text")?.name;

  return (
    <div className="cimisy-entry-layout">
      <div className="cimisy-entry-main">
        <form onSubmit={handleSubmit}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <Breadcrumb
              basePath={basePath}
              trail={[
                { label: collection.label, href: `${basePath}/${collection.key}` },
                { label: slug ?? "New entry" },
              ]}
            />
            {canPreview && (
              <button
                type="button"
                className="cimisy-btn cimisy-btn-secondary"
                onClick={() => setPreviewOpen((o) => !o)}
              >
                {previewOpen ? "Hide preview" : "Show preview"}
              </button>
            )}
          </div>
          {error && <p className="cimisy-banner cimisy-banner-danger">{error}</p>}
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
            titleField={titleFieldName}
          />
          <div className="cimisy-action-bar">
            <div className="cimisy-action-bar-status">
              {publishResult?.status === "draft" && publishResult.branch && (
                <span className="cimisy-chip-branch">{publishResult.branch}</span>
              )}
              {publishResult?.status === "draft" && publishResult.pullRequestUrl && (
                <a
                  className="cimisy-link"
                  style={{ fontSize: "0.85em" }}
                  href={publishResult.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Pull request opened &rarr;
                </a>
              )}
              {publishResult?.status === "direct" && (
                <span className="cimisy-badge">
                  <span className="cimisy-badge-dot cimisy-badge-dot-success" />
                  Published
                </span>
              )}
              {/* No publish-status claim before this session's first save — the initial GET
                  doesn't report it, and guessing would misrepresent an already-published entry. */}
              {!publishResult && !slug && (
                <span className="cimisy-badge">
                  <span className="cimisy-badge-dot cimisy-badge-dot-warning" />
                  New entry
                </span>
              )}
            </div>
            <button type="submit" className="cimisy-btn cimisy-btn-primary">
              Save
            </button>
          </div>
        </form>
        {slug && (
          <HistoryPanel historyPath={`/collections/${collection.key}/${slug}/history`} apiBasePath={apiBasePath} />
        )}
      </div>
      {canPreview && previewOpen && slug && collection.previewPath && (
        <div className="cimisy-entry-preview">
          <div className="cimisy-preview-header">
            <span className="cimisy-preview-eyebrow">Draft mode preview</span>
            <span className="cimisy-badge">
              <span className={`cimisy-badge-dot cimisy-badge-dot-${dirty ? "warning" : "accent"}`} />
              {dirty ? "unsaved changes" : "draft"}
            </span>
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
  isTitle,
}: {
  field: FieldManifest;
  value: unknown;
  onChange: (value: unknown) => void;
  apiBasePath: string;
  targetKey: string;
  slug: string | null;
  draftRef?: string;
  isTitle?: boolean;
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
  if (field.kind === "array") {
    return <ArrayField field={field} value={value} onChange={onChange} />;
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
  if (isTitle) {
    return (
      <div className="cimisy-title-field">
        <label className="cimisy-title-label" htmlFor={field.name}>
          {field.label}
        </label>
        <input
          id={field.name}
          className="cimisy-title-input"
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.label}
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
