"use client";

import { useEffect, useState } from "react";
// Type-only imports — erased at compile time, so this client module never
// pulls the scan stack (and its TypeScript-compiler dependency) into the bundle.
import type { ScanMode } from "../../scan/modes.js";
import type { ScanReport } from "../../scan/report.js";
import { apiUrl } from "./api.js";

const MODES: Array<{ value: ScanMode; label: string; hint: string }> = [
  { value: "collections", label: "Collections", hint: "repeating .map()'d arrays only" },
  { value: "collections-metadata", label: "Collections + metadata", hint: "+ page SEO metadata (export const metadata)" },
  { value: "static", label: "Static", hint: "+ static headings/paragraphs/images/links" },
  { value: "static-metadata", label: "Everything", hint: "collections, static content, and page metadata" },
];

type SelectionKind = "collection" | "static" | "metadata";

interface ImportResultItem {
  kind: SelectionKind;
  index: number;
  label: string;
  ok: boolean;
  error?: string;
  itemFailures?: Array<{ index: number; error: string }>;
  itemsImported?: number;
  itemsTotal?: number;
}

function selectionKey(kind: SelectionKind, index: number): string {
  return `${kind}:${index}`;
}

/**
 * The dev-only scan/import screen — the in-admin counterpart of
 * `cimisy scan` + `cimisy import`. Only routed when
 * manifest.scanSupported (local adapter, non-production); the API
 * routes re-check the same gate server-side, so this component being
 * bundled is never what decides whether scanning is possible.
 * Results are grouped exactly like the CLI's printScanReport: eligible
 * candidates (checkboxes) first, each "detected but not import-eligible"
 * bucket with reasons after.
 */
export function ScanPage({ basePath, apiBasePath }: { basePath: string; apiBasePath: string }) {
  const [report, setReport] = useState<ScanReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<ScanMode>("static-metadata");
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<{ message: string; code?: string } | null>(null);
  const [allowDirty, setAllowDirty] = useState(false);
  const [importResult, setImportResult] = useState<{ branch: string; results: ImportResultItem[] } | null>(null);
  /** Set after a successful import: the cached report's byte offsets no longer match the rewritten sources, so importing again from it would corrupt files — force a fresh scan first. */
  const [reportStale, setReportStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl(apiBasePath, "/scan/report"))
      .then(async (res) => {
        const data = (await res.json()) as { report?: ScanReport | null; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data.error ?? "Failed to load the last scan report.");
        } else {
          setReport(data.report ?? null);
          if (data.report?.mode) setMode(data.report.mode);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError("Failed to load the last scan report.");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiBasePath]);

  async function runScan() {
    setScanning(true);
    setScanError(null);
    setImportResult(null);
    setImportError(null);
    setSelected(new Set());
    try {
      const res = await fetch(apiUrl(apiBasePath, "/scan"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = (await res.json()) as { report?: ScanReport; warnings?: string[]; error?: string };
      if (!res.ok || !data.report) {
        setScanError(data.error ?? "Scan failed.");
        return;
      }
      setReport(data.report);
      setWarnings(data.warnings ?? []);
      setReportStale(false);
    } catch {
      setScanError("Scan failed — couldn't reach the admin API.");
    } finally {
      setScanning(false);
    }
  }

  async function runImport() {
    const selections = [...selected].map((key) => {
      const [kind, index] = key.split(":");
      return { kind: kind as SelectionKind, index: Number(index) };
    });
    if (selections.length === 0) return;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    try {
      const res = await fetch(apiUrl(apiBasePath, "/scan/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selections, ...(allowDirty ? { allowDirty: true } : {}) }),
      });
      const data = (await res.json()) as { branch?: string; results?: ImportResultItem[]; error?: string; code?: string };
      if (!res.ok || !data.branch || !data.results) {
        setImportError({ message: data.error ?? "Import failed.", code: data.code });
        return;
      }
      setImportResult({ branch: data.branch, results: data.results });
      setSelected(new Set());
      setReportStale(true);
    } catch {
      setImportError({ message: "Import failed — couldn't reach the admin API." });
    } finally {
      setImporting(false);
    }
  }

  function toggle(kind: SelectionKind, index: number) {
    const key = selectionKey(kind, index);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const staticCandidates = report?.staticContentCandidates ?? [];
  const metadataCandidates = report?.pageMetadataCandidates ?? [];
  const staticUnanalyzable = report?.staticUnanalyzable ?? [];
  const metadataUnanalyzable = report?.pageMetadataUnanalyzable ?? [];
  const hasFindings =
    report !== null &&
    (report.collectionCandidates.length > 0 ||
      report.unanalyzable.length > 0 ||
      staticCandidates.length > 0 ||
      staticUnanalyzable.length > 0 ||
      metadataCandidates.length > 0 ||
      metadataUnanalyzable.length > 0);

  return (
    <div>
      <a className="cimisy-crumb cimisy-link" href={basePath}>
        &larr; Content
      </a>
      <h1 className="cimisy-heading" style={{ marginBottom: 8 }}>
        Scan &amp; import
      </h1>
      <p className="cimisy-muted" style={{ marginTop: 0, maxWidth: "62ch" }}>
        Scan this project&apos;s source for hardcoded content and bring selected pieces under cimisy&apos;s
        management. Imports rewrite source files on a dedicated <code>cimisy/import-…</code> git branch, so
        everything is reviewable before it lands.{" "}
        <span className="cimisy-badge" style={{ verticalAlign: "middle" }}>
          <span className="cimisy-badge-dot cimisy-badge-dot-accent" />
          local dev only
        </span>
      </p>

      <div className="cimisy-scan-controls">
        <div className="cimisy-field" style={{ marginBottom: 0, flex: "1 1 260px" }}>
          <label className="cimisy-label" htmlFor="cimisy-scan-mode">
            Scan depth
          </label>
          <select
            id="cimisy-scan-mode"
            className="cimisy-select"
            value={mode}
            onChange={(e) => setMode(e.target.value as ScanMode)}
            disabled={scanning}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label} — {m.hint}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="cimisy-btn cimisy-btn-primary" onClick={runScan} disabled={scanning}>
          {scanning ? "Scanning…" : report ? "Re-run scan" : "Run scan"}
        </button>
      </div>

      {scanError && (
        <p className="cimisy-banner cimisy-banner-danger" role="alert">
          {scanError}
        </p>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="cimisy-banner cimisy-banner-warning" role="status">
          {warning}
        </p>
      ))}

      {loading ? (
        <div className="cimisy-skeleton-stack" role="status" aria-label="Loading last scan report">
          <div className="cimisy-skeleton cimisy-skeleton-card" />
          <div className="cimisy-skeleton cimisy-skeleton-card" />
        </div>
      ) : loadError ? (
        <p className="cimisy-banner cimisy-banner-danger" role="alert">
          {loadError}
        </p>
      ) : report === null ? (
        <div className="cimisy-empty-state">
          <p className="cimisy-empty-state-title">No scan yet</p>
          <p className="cimisy-muted" style={{ margin: 0 }}>
            Run a scan to see what hardcoded content could move into cimisy.
          </p>
        </div>
      ) : (
        <>
          <p className="cimisy-muted" style={{ fontSize: "0.85em" }}>
            Last scan: {new Date(report.generatedAt).toLocaleString()} · mode <code>{report.mode ?? "collections"}</code>
          </p>
          {reportStale && (
            <p className="cimisy-banner cimisy-banner-warning" role="status">
              Sources were rewritten by the import below — re-run the scan before importing anything else.
            </p>
          )}
          {!hasFindings && <p className="cimisy-empty">No hardcoded content candidates found — this project is clean.</p>}

          {report.collectionCandidates.length > 0 && (
            <section className="cimisy-scan-section">
              <h2 className="cimisy-subheading">Collection candidates</h2>
              {report.collectionCandidates.map((candidate, index) => (
                <CandidateRow
                  key={`collection-${index}`}
                  checked={selected.has(selectionKey("collection", index))}
                  onToggle={() => toggle("collection", index)}
                  disabled={importing || reportStale}
                  badge="collection"
                  title={candidate.variableName}
                  meta={`${candidate.itemCount} items · ${candidate.sourceFile} · used on ${candidate.usedOnRoutes.join(", ")}`}
                  fields={candidate.proposal.fields.map((f) => `${f.name}: ${f.proposedKind}`)}
                />
              ))}
            </section>
          )}

          {staticCandidates.length > 0 && (
            <section className="cimisy-scan-section">
              <h2 className="cimisy-subheading">Static content candidates</h2>
              {staticCandidates.map((candidate, index) => (
                <CandidateRow
                  key={`static-${index}`}
                  checked={selected.has(selectionKey("static", index))}
                  onToggle={() => toggle("static", index)}
                  disabled={importing || reportStale}
                  badge={candidate.scope === "top-level-singleton" ? "singleton" : "section"}
                  title={candidate.proposedKey}
                  meta={`${candidate.fields.length} field(s) · ${candidate.sourceFile} · used on ${candidate.usedOnRoutes.join(", ")}`}
                  fields={candidate.proposal.fields.map((f) => `${f.name}: ${f.proposedKind}`)}
                />
              ))}
            </section>
          )}

          {metadataCandidates.length > 0 && (
            <section className="cimisy-scan-section">
              <h2 className="cimisy-subheading">Page metadata candidates</h2>
              {metadataCandidates.map((candidate, index) => {
                const parts = [
                  candidate.title !== undefined ? "title" : null,
                  candidate.description !== undefined ? "description" : null,
                  candidate.canonical !== undefined ? "canonical" : null,
                ].filter(Boolean);
                return candidate.pageKey ? (
                  <CandidateRow
                    key={`metadata-${index}`}
                    checked={selected.has(selectionKey("metadata", index))}
                    onToggle={() => toggle("metadata", index)}
                    disabled={importing || reportStale}
                    badge="metadata"
                    title={`${candidate.routePath} → pages.${candidate.pageKey}.seo`}
                    meta={`${parts.join(", ")} · ${candidate.sourceFile}`}
                  />
                ) : null;
              })}
            </section>
          )}

          {(report.unanalyzable.length > 0 || staticUnanalyzable.length > 0 || metadataUnanalyzable.length > 0) && (
            <section className="cimisy-scan-section">
              <h2 className="cimisy-subheading">Detected but not import-eligible</h2>
              <ul className="cimisy-scan-ineligible">
                {report.unanalyzable.map((item, index) => (
                  <li key={`u-${index}`}>
                    <strong>{item.variableName}</strong> <span className="cimisy-muted">({item.sourceFile})</span> — {item.reason}
                  </li>
                ))}
                {staticUnanalyzable.map((item, index) => (
                  <li key={`su-${index}`}>
                    <strong>{item.regionHint}</strong> <span className="cimisy-muted">({item.sourceFile})</span> — {item.reason}
                  </li>
                ))}
                {metadataUnanalyzable.map((item, index) => (
                  <li key={`mu-${index}`}>
                    <strong>{item.routePath}</strong> <span className="cimisy-muted">({item.sourceFile})</span> — {item.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {importError && (
            <div className="cimisy-banner cimisy-banner-danger" role="alert">
              {importError.message}
              {importError.code === "DIRTY_TREE" && (
                <label style={{ display: "block", marginTop: 8, fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={allowDirty}
                    onChange={(e) => setAllowDirty(e.target.checked)}
                    style={{ marginRight: 6 }}
                  />
                  Import anyway (I understand uncommitted changes end up mixed into the import branch)
                </label>
              )}
            </div>
          )}

          {importResult && (
            <div className="cimisy-banner cimisy-banner-success" role="status">
              <p style={{ margin: "0 0 8px", fontWeight: 650 }}>
                Import finished on branch <code>{importResult.branch}</code> — review with <code>git diff</code>, then
                commit when you&apos;re happy.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {importResult.results.map((r) => (
                  <li key={`${r.kind}-${r.index}`}>
                    {r.label}:{" "}
                    {r.ok
                      ? r.itemsTotal !== undefined
                        ? `${r.itemsImported}/${r.itemsTotal} items imported`
                        : "imported"
                      : `failed — ${r.error}`}
                    {r.itemFailures?.map((f) => (
                      <span key={f.index} style={{ display: "block" }}>
                        item {f.index}: {f.error}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(report.collectionCandidates.length > 0 || staticCandidates.length > 0 || metadataCandidates.length > 0) && (
            <div className="cimisy-action-bar">
              <div className="cimisy-action-bar-status">
                <span className="cimisy-muted" style={{ fontSize: "0.9em" }}>
                  {selected.size} selected
                </span>
              </div>
              <button
                type="button"
                className="cimisy-btn cimisy-btn-primary"
                disabled={selected.size === 0 || importing || reportStale}
                onClick={runImport}
              >
                {importing ? "Importing…" : "Import selected"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CandidateRow({
  checked,
  onToggle,
  disabled,
  badge,
  title,
  meta,
  fields,
}: {
  checked: boolean;
  onToggle: () => void;
  disabled: boolean;
  badge: string;
  title: string;
  meta: string;
  fields?: string[];
}) {
  return (
    <label className={`cimisy-scan-candidate${checked ? " is-selected" : ""}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} />
      <span className="cimisy-scan-candidate-body">
        <span className="cimisy-scan-candidate-title">
          <span className="cimisy-badge">{badge}</span> <strong>{title}</strong>
        </span>
        <span className="cimisy-muted cimisy-scan-candidate-meta">{meta}</span>
        {fields && fields.length > 0 && <code className="cimisy-scan-candidate-fields">{fields.join("  ·  ")}</code>}
      </span>
    </label>
  );
}
