"use client";

import { type FormEvent, useEffect, useState } from "react";
import type { SingletonManifest } from "../../next/manifest.js";
import { type PublishResult, apiUrl } from "./api.js";
import {
  Breadcrumb,
  buildSingletonPreviewUrl,
  FieldsEditor,
  mapIssuesToFieldErrors,
  requiredFieldErrors,
  RestoreDraftPrompt,
} from "./entry-form.js";
import { HistoryPanel } from "./history.js";
import { draftStorageKey, useLocalDraft } from "./use-local-draft.js";
import { useSaveShortcut } from "./use-save-shortcut.js";
import { useUnsavedChangesGuard } from "./use-unsaved-guard.js";

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
  // Distinct from `error` (a failed *save*, shown inline above a fillable form that still has
  // real values in it): a failed *load* means `values`/`version` never got populated, so the
  // form can't be shown at all — submitting it would overwrite the real file with blanks.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [draftRef, setDraftRef] = useState<string | undefined>(undefined);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  useUnsavedChangesGuard(dirty);

  const { pendingDraft, restoreDraft, discardDraft, clearDraft } = useLocalDraft({
    storageKey: draftStorageKey(singleton.key, SINGLETON_SLUG),
    ready: !loading && !loadError,
    values,
    dirty,
  });

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl(apiBasePath, `/singletons/${singleton.key}`))
      .then(async (res) => {
        const data = (await res.json()) as {
          singleton?: { values: Record<string, unknown>; version: string } | null;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data.error ?? "Failed to load this singleton.");
          setLoading(false);
          return;
        }
        if (data.singleton) {
          setValues(data.singleton.values);
          setVersion(data.singleton.version);
        } else {
          setNeverSaved(true);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError("Failed to load this singleton.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [singleton.key, apiBasePath]);

  async function submit() {
    setError(null);
    setFieldErrors({});
    const preSubmitErrors = requiredFieldErrors(singleton.fields, values);
    if (Object.keys(preSubmitErrors).length > 0) {
      setFieldErrors(preSubmitErrors);
      return;
    }
    const res = await fetch(apiUrl(apiBasePath, `/singletons/${singleton.key}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values, baseVersion: version }),
    });
    const data = (await res.json()) as { version?: string; publish?: PublishResult; error?: string; issues?: unknown };
    if (!res.ok || !data.version) {
      const mapped = mapIssuesToFieldErrors(
        data.issues,
        singleton.fields.map((f) => f.name),
      );
      setFieldErrors(mapped.fieldErrors);
      // The generic banner only carries what no input can display inline.
      if (Object.keys(mapped.fieldErrors).length === 0 || mapped.unmapped.length > 0) {
        setError(mapped.unmapped[0] ?? data.error ?? "Save failed");
      }
      return;
    }
    setVersion(data.version);
    setPublishResult(data.publish ?? null);
    if (data.publish?.status === "draft") setDraftRef(data.publish.branch);
    setNeverSaved(false);
    setDirty(false);
    clearDraft();
    setPreviewKey((k) => k + 1);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  useSaveShortcut(() => {
    if (!loading && !loadError && !pendingDraft) void submit();
  });

  if (loading) {
    return (
      <div className="cimisy-skeleton-stack" role="status" aria-label="Loading singleton">
        <div className="cimisy-skeleton cimisy-skeleton-line" style={{ width: 220 }} />
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
        <Breadcrumb basePath={basePath} trail={[{ label: singleton.label }]} />
        <p className="cimisy-banner cimisy-banner-danger">{loadError}</p>
      </div>
    );
  }

  // Gate, not banner — see use-local-draft.ts's doc comment (the Tiptap
  // editor must mount with the chosen values, it can't resync afterward).
  if (pendingDraft) {
    return (
      <div>
        <Breadcrumb basePath={basePath} trail={[{ label: singleton.label }]} />
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

  const canPreview = Boolean(singleton.previewPath);

  return (
    <div className="cimisy-entry-layout">
      <div className="cimisy-entry-main">
        <form onSubmit={handleSubmit}>
          <div className="cimisy-form-header">
            <Breadcrumb basePath={basePath} trail={[{ label: singleton.label }]} />
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
          {neverSaved && <p className="cimisy-muted">Not created yet — fill in the fields and save.</p>}
          {error && (
            <p className="cimisy-banner cimisy-banner-danger" role="alert">
              {error}
            </p>
          )}
          <FieldsEditor
            fields={singleton.fields}
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
            targetKey={singleton.key}
            slug={SINGLETON_SLUG}
            draftRef={draftRef}
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
            </div>
            <button type="submit" className="cimisy-btn cimisy-btn-primary">
              {neverSaved ? "Create" : "Save"}
            </button>
          </div>
        </form>
        <HistoryPanel historyPath={`/singletons/${singleton.key}/history`} apiBasePath={apiBasePath} />
      </div>
      {canPreview && previewOpen && singleton.previewPath && (
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
            src={buildSingletonPreviewUrl(apiBasePath, singleton.key, singleton.previewPath)}
          />
        </div>
      )}
    </div>
  );
}
