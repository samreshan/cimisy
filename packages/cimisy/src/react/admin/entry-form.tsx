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
import { draftStorageKey, useLocalDraft } from "./use-local-draft.js";
import { useSaveShortcut } from "./use-save-shortcut.js";
import { useUnsavedChangesGuard } from "./use-unsaved-guard.js";

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

/** The autosaved-draft recovery prompt (see use-local-draft.ts) — shared by EntryForm and SingletonForm, rendered in place of the form until the user chooses. */
export function RestoreDraftPrompt({
  savedAt,
  onRestore,
  onDiscard,
}: {
  savedAt: string;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="cimisy-empty-state" role="alertdialog" aria-label="Restore unsaved draft">
      <p className="cimisy-empty-state-title">Restore unsaved draft?</p>
      <p className="cimisy-muted" style={{ margin: 0 }}>
        This entry has unsaved edits from {new Date(savedAt).toLocaleString()} that were never saved to the server.
      </p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
        <button type="button" className="cimisy-btn cimisy-btn-primary" onClick={onRestore}>
          Restore draft
        </button>
        <button type="button" className="cimisy-btn cimisy-btn-secondary" onClick={onDiscard}>
          Discard it
        </button>
      </div>
    </div>
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
  errors,
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
  /** Per-field validation messages (field name → message), from the pre-submit check or a 400's field-prefixed issues. */
  errors?: Record<string, string>;
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
          error={errors?.[field.name]}
        />
      ))}
    </>
  );
}

/**
 * Maps a 400 response's field-prefixed issues (see content/validate-values.ts —
 * `path[0]` is the field name) to a field→message record for FieldsEditor.
 * Issues that don't name a known field fall through to `unmapped` so the
 * caller can keep showing them in the generic banner instead of dropping them.
 */
export function mapIssuesToFieldErrors(
  issues: unknown,
  fieldNames: string[],
): { fieldErrors: Record<string, string>; unmapped: string[] } {
  const fieldErrors: Record<string, string> = {};
  const unmapped: string[] = [];
  if (!Array.isArray(issues)) return { fieldErrors, unmapped };
  for (const issue of issues as { path?: (string | number)[]; message?: string }[]) {
    const fieldName = issue?.path?.[0];
    const message = issue?.message ?? "Invalid value.";
    if (typeof fieldName === "string" && fieldNames.includes(fieldName)) {
      // First message per field wins — one inline line per input, not a stack.
      fieldErrors[fieldName] ??= message;
    } else {
      unmapped.push(message);
    }
  }
  return { fieldErrors, unmapped };
}

/** Pre-submit required check mirroring the server's validation — catches empty required fields without a round-trip. */
export function requiredFieldErrors(fields: FieldManifest[], values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (!field.required) continue;
    const value = values[field.name];
    if (field.kind === "number") {
      if (typeof value !== "number" || Number.isNaN(value)) errors[field.name] = "Required.";
    } else if (typeof value !== "string" || value.length === 0) {
      errors[field.name] = "Required.";
    }
  }
  return errors;
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
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
  // Two-step inline confirm ("Delete entry" → "Really delete?") instead of window.confirm —
  // consistent with the theme and testable. `notice` carries the draft-deletion outcome.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useUnsavedChangesGuard(dirty);

  const { pendingDraft, restoreDraft, discardDraft, clearDraft } = useLocalDraft({
    storageKey: draftStorageKey(collection.key, slug),
    ready: !loading && !loadError,
    values,
    dirty,
  });

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

  async function submit() {
    setError(null);
    setFieldErrors({});
    const preSubmitErrors = requiredFieldErrors(collection.fields, values);
    if (Object.keys(preSubmitErrors).length > 0) {
      setFieldErrors(preSubmitErrors);
      return;
    }
    const res = await fetch(apiUrl(apiBasePath, `/collections/${collection.key}${slug ? `/${slug}` : ""}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values, baseVersion: version }),
    });
    const data = (await res.json()) as {
      slug?: string;
      version?: string;
      publish?: PublishResult;
      error?: string;
      issues?: unknown;
    };
    if (!res.ok || !data.slug) {
      const mapped = mapIssuesToFieldErrors(
        data.issues,
        collection.fields.map((f) => f.name),
      );
      setFieldErrors(mapped.fieldErrors);
      // The generic banner only carries what no input can display inline.
      if (Object.keys(mapped.fieldErrors).length === 0 || mapped.unmapped.length > 0) {
        setError(mapped.unmapped[0] ?? data.error ?? "Save failed");
      }
      return;
    }
    setVersion(data.version ?? null);
    setPublishResult(data.publish ?? null);
    if (data.publish?.status === "draft") setDraftRef(data.publish.branch);
    setDirty(false);
    clearDraft();
    setPreviewKey((k) => k + 1);
    router.push(`${basePath}/${collection.key}/${data.slug}`);
    router.refresh();
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  useSaveShortcut(() => {
    if (!loading && !loadError && !pendingDraft && !deleting) void submit();
  });

  async function handleDelete() {
    if (!slug) return;
    setError(null);
    setNotice(null);
    setDeleting(true);
    const res = await fetch(apiUrl(apiBasePath, `/collections/${collection.key}/${slug}`), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseVersion: version }),
    });
    const data = (await res.json()) as { ok?: boolean; publish?: PublishResult; error?: string };
    setDeleting(false);
    setConfirmingDelete(false);
    if (!res.ok || !data.ok) {
      setError(data.error ?? "Delete failed");
      return;
    }
    if (data.publish?.status === "draft") {
      // The entry still exists on the default branch — deletion itself is a
      // reviewed change for draft-role users. Stay on the form and surface the PR.
      setPublishResult(data.publish);
      setDraftRef(data.publish.branch);
      setNotice("Deletion opened as a draft pull request — the entry stays published until it's approved.");
      return;
    }
    setDirty(false);
    clearDraft();
    router.push(`${basePath}/${collection.key}`);
    router.refresh();
  }

  if (loading) {
    return (
      <div className="cimisy-skeleton-stack" role="status" aria-label="Loading entry">
        <div className="cimisy-skeleton cimisy-skeleton-line" style={{ width: 220 }} />
        <div className="cimisy-skeleton cimisy-skeleton-title" />
        <div className="cimisy-skeleton cimisy-skeleton-input" />
        <div className="cimisy-skeleton cimisy-skeleton-input" />
        <div className="cimisy-skeleton cimisy-skeleton-input" style={{ height: 180 }} />
      </div>
    );
  }

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

  // Gate, not banner: the form (and its mount-once Tiptap editor) must not
  // render until the user picks which values it should mount with — see
  // use-local-draft.ts's doc comment.
  if (pendingDraft) {
    return (
      <div>
        <Breadcrumb
          basePath={basePath}
          trail={[{ label: collection.label, href: `${basePath}/${collection.key}` }, { label: slug ?? "New entry" }]}
        />
        <RestoreDraftPrompt
          savedAt={pendingDraft.savedAt}
          onRestore={() => {
            const restored = restoreDraft();
            if (restored) {
              setValues(restored);
              setDirty(true);
            }
          }}
          onDiscard={discardDraft}
        />
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
          <div className="cimisy-form-header">
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
          {error && (
            <p className="cimisy-banner cimisy-banner-danger" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="cimisy-banner cimisy-banner-warning" role="status">
              {notice}
            </p>
          )}
          <FieldsEditor
            fields={collection.fields}
            values={values}
            errors={fieldErrors}
            onChange={(fieldName, v) => {
              setValues((prev) => ({ ...prev, [fieldName]: v }));
              setDirty(true);
              setFieldErrors((prev) => {
                if (!(fieldName in prev)) return prev;
                const next = { ...prev };
                delete next[fieldName];
                return next;
              });
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
                <span
                  className="cimisy-chip-branch"
                  title="Your changes are saved on this git branch — they go live when the pull request is approved and merged."
                >
                  {publishResult.branch}
                </span>
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
            <span className="cimisy-form-actions">
              {slug &&
                (confirmingDelete ? (
                  <>
                    <button
                      type="button"
                      className="cimisy-btn cimisy-btn-danger"
                      disabled={deleting}
                      onClick={handleDelete}
                    >
                      {deleting ? "Deleting…" : "Really delete?"}
                    </button>
                    <button
                      type="button"
                      className="cimisy-btn cimisy-btn-ghost"
                      disabled={deleting}
                      onClick={() => setConfirmingDelete(false)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="cimisy-btn cimisy-btn-ghost"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    Delete entry
                  </button>
                ))}
              <button type="submit" className="cimisy-btn cimisy-btn-primary">
                Save
              </button>
            </span>
          </div>
        </form>
        {slug && (
          <HistoryPanel historyPath={`/collections/${collection.key}/${slug}/history`} apiBasePath={apiBasePath} />
        )}
      </div>
      {canPreview && previewOpen && slug && collection.previewPath && (
        <div className="cimisy-entry-preview">
          <div className="cimisy-preview-header">
            <span className="cimisy-preview-eyebrow">Preview · last saved version</span>
            <span className="cimisy-badge" title="The preview reloads on every save — it never shows unsaved edits.">
              <span className={`cimisy-badge-dot cimisy-badge-dot-${dirty ? "warning" : "accent"}`} />
              {dirty ? "save to update" : "up to date"}
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
  error,
}: {
  field: FieldManifest;
  value: unknown;
  onChange: (value: unknown) => void;
  apiBasePath: string;
  targetKey: string;
  slug: string | null;
  draftRef?: string;
  isTitle?: boolean;
  error?: string;
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
  if (field.kind === "boolean") {
    return (
      <div className="cimisy-field">
        <label className="cimisy-label cimisy-toggle-label" htmlFor={field.name}>
          <input
            id={field.name}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          {field.label}
        </label>
      </div>
    );
  }
  if (field.kind === "number") {
    return (
      <div className="cimisy-field">
        <label className="cimisy-label" htmlFor={field.name}>
          {field.label}
          {field.required && (
            <span className="cimisy-required-marker" aria-hidden="true">
              *
            </span>
          )}
        </label>
        <input
          id={field.name}
          className="cimisy-input"
          type="number"
          value={typeof value === "number" ? value : ""}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          aria-required={field.required || undefined}
          aria-invalid={error ? true : undefined}
        />
        {error && (
          <p className="cimisy-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
  if (field.kind === "select") {
    return (
      <div className="cimisy-field">
        <label className="cimisy-label" htmlFor={field.name}>
          {field.label}
          {field.required && (
            <span className="cimisy-required-marker" aria-hidden="true">
              *
            </span>
          )}
        </label>
        <select
          id={field.name}
          className="cimisy-select"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          aria-required={field.required || undefined}
          aria-invalid={error ? true : undefined}
        >
          {!field.required && <option value="">—</option>}
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {error && (
          <p className="cimisy-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
  if (field.kind === "text" && field.multiline && !isTitle) {
    return (
      <div className="cimisy-field">
        <label className="cimisy-label" htmlFor={field.name}>
          {field.label}
          {field.required && (
            <span className="cimisy-required-marker" aria-hidden="true">
              *
            </span>
          )}
        </label>
        <textarea
          id={field.name}
          className="cimisy-textarea"
          rows={4}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          maxLength={field.maxLength}
          aria-required={field.required || undefined}
          aria-invalid={error ? true : undefined}
        />
        {error && (
          <p className="cimisy-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
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
          {field.required && (
            <span className="cimisy-required-marker" aria-hidden="true">
              *
            </span>
          )}
        </label>
        <input
          id={field.name}
          className="cimisy-title-input"
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.label}
          maxLength={field.maxLength}
          aria-required={field.required || undefined}
          aria-invalid={error ? true : undefined}
        />
        {error && (
          <p className="cimisy-field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="cimisy-field">
      <label className="cimisy-label" htmlFor={field.name}>
        {field.label}
        {field.required && (
          <span className="cimisy-required-marker" aria-hidden="true">
            *
          </span>
        )}
      </label>
      <input
        id={field.name}
        className="cimisy-input"
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        maxLength={field.maxLength}
        aria-required={field.required || undefined}
        aria-invalid={error ? true : undefined}
      />
      {error && (
        <p className="cimisy-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
