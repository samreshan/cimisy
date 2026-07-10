"use client";

import { useRef, useState } from "react";
import type { FieldManifest } from "../../next/manifest.js";
import { apiUrl } from "./api.js";

interface MediaFile {
  path: string;
  version: string;
}

/** Reads a File as base64 (no data: URL prefix) — the shape POST /media expects. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error instanceof Error ? reader.error : new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

/**
 * The `fields.image()` editor: thumbnail preview (via GET /media/raw),
 * upload (via POST /media), and a browse-existing picker (via GET
 * /media). `slug` gates uploads: media lands on the same draft branch (or
 * main) as the entry it's attached to (see route-handler.ts's
 * resolveWriteRef), which requires a resolved slug — a brand-new,
 * never-saved entry doesn't have one yet, so uploads are disabled with an
 * explanatory hint until the entry has been saved at least once.
 * `draftRef` mirrors whatever branch the entry itself is currently saved
 * on, so thumbnails resolve correctly for images that only exist on an
 * undeployed draft branch.
 */
export function ImageField({
  field,
  value,
  onChange,
  apiBasePath,
  collectionName,
  slug,
  draftRef,
}: {
  field: FieldManifest;
  value: unknown;
  onChange: (value: string | null) => void;
  apiBasePath: string;
  collectionName: string;
  slug: string | null;
  draftRef?: string;
}) {
  const directory = field.directory;
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [existing, setExisting] = useState<MediaFile[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const currentPath = typeof value === "string" && value ? value : null;

  function thumbnailUrl(path: string): string {
    const params = new URLSearchParams({ path, ...(draftRef ? { ref: draftRef } : {}) });
    return apiUrl(apiBasePath, `/media/raw?${params.toString()}`);
  }

  async function handleFileSelected(file: File) {
    if (!directory || !slug) return;
    setUploading(true);
    setError(null);
    try {
      const content = await fileToBase64(file);
      const res = await fetch(apiUrl(apiBasePath, "/media"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectionName, slug, directory, filename: file.name, content }),
      });
      const data = (await res.json()) as { path?: string; error?: string };
      if (!res.ok || !data.path) {
        setError(data.error ?? "Upload failed.");
        return;
      }
      onChange(data.path);
    } catch {
      setError("Upload failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function openBrowse() {
    if (!directory) return;
    setBrowsing(true);
    setError(null);
    setExisting(null);
    const params = new URLSearchParams({ directory, ...(draftRef ? { ref: draftRef } : {}) });
    const res = await fetch(apiUrl(apiBasePath, `/media?${params.toString()}`));
    const data = (await res.json()) as { files?: MediaFile[]; error?: string };
    if (!res.ok) {
      setError(data.error ?? "Failed to load existing uploads.");
      setBrowsing(false);
      return;
    }
    setExisting(data.files ?? []);
  }

  return (
    <div className="cimisy-field">
      <label className="cimisy-label">{field.label}</label>
      {error && <p className="cimisy-banner cimisy-banner-danger">{error}</p>}
      {currentPath ? (
        <div style={{ marginBottom: 10 }}>
          <img
            src={thumbnailUrl(currentPath)}
            alt=""
            style={{ maxWidth: 200, maxHeight: 200, display: "block", borderRadius: 8, marginBottom: 6 }}
          />
          <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => onChange(null)}>
            Remove
          </button>
        </div>
      ) : (
        <p className="cimisy-muted" style={{ marginBottom: 10 }}>
          No image selected.
        </p>
      )}
      {!slug ? (
        <p className="cimisy-muted">Save the entry first to enable uploads.</p>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFileSelected(file);
            }}
          />
          <button
            type="button"
            className="cimisy-btn cimisy-btn-secondary"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? "Uploading…" : "Upload…"}
          </button>
          <button type="button" className="cimisy-btn cimisy-btn-secondary" onClick={openBrowse}>
            Browse existing…
          </button>
        </div>
      )}
      {browsing && (
        <div className="cimisy-block-list" style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span className="cimisy-muted" style={{ fontSize: "0.85em" }}>
              Existing uploads
            </span>
            <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => setBrowsing(false)}>
              Close
            </button>
          </div>
          {existing === null ? (
            <p className="cimisy-muted">Loading…</p>
          ) : existing.length === 0 ? (
            <p className="cimisy-muted">No uploads yet.</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {existing.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => {
                    onChange(f.path);
                    setBrowsing(false);
                  }}
                  style={{ border: "none", background: "none", padding: 0, cursor: "pointer" }}
                >
                  <img src={thumbnailUrl(f.path)} alt="" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6 }} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
