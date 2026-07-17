"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AdminManifest } from "../../next/manifest.js";
import { type PublishResult, apiUrl } from "./api.js";

interface MediaFile {
  path: string;
  version: string;
}

/** Reads a File as base64 (no data: URL prefix) — the shape POST /media expects. Duplicated from image-field.tsx's private helper on purpose: both are 10 lines, a shared module isn't worth the coupling yet. */
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

/** Every image directory the config exposes — from image fields and seo fields' og-image directories, the same set the server allowlists (content/media.ts). */
export function collectImageDirectories(manifest: AdminManifest): string[] {
  const directories = new Set<string>();
  for (const entity of Object.values(manifest.byKey)) {
    for (const field of entity.fields) {
      if (field.directory) directories.add(field.directory);
    }
  }
  return [...directories].sort();
}

/**
 * The standalone media library (`/admin/media`): browse every configured
 * image directory, upload (click or drag-and-drop), copy a file's path for
 * reuse, and delete. Until 2.4 media was only reachable inside an image
 * field's "Browse existing…" picker. Alt text stays a per-usage concern
 * (it lives on the image field/block where the image is used, not on the
 * file), so there's no alt input here.
 */
export function MediaLibraryPage({ manifest, basePath, apiBasePath }: { manifest: AdminManifest; basePath: string; apiBasePath: string }) {
  const directories = useMemo(() => collectImageDirectories(manifest), [manifest]);
  const [directory, setDirectory] = useState<string | null>(directories[0] ?? null);
  const [files, setFiles] = useState<MediaFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!directory) return;
    let cancelled = false;
    setError(null);
    setFiles(null);
    fetch(apiUrl(apiBasePath, `/media?${new URLSearchParams({ directory }).toString()}`))
      .then(async (res) => {
        const data = (await res.json()) as { files?: MediaFile[]; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "Failed to load uploads.");
          return;
        }
        setFiles(data.files ?? []);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load uploads.");
      });
    return () => {
      cancelled = true;
    };
  }, [directory, apiBasePath, reloadKey]);

  function thumbnailUrl(path: string): string {
    return apiUrl(apiBasePath, `/media/raw?${new URLSearchParams({ path }).toString()}`);
  }

  async function upload(fileList: FileList | File[]) {
    if (!directory) return;
    setUploading(true);
    setError(null);
    setNotice(null);
    let uploaded = 0;
    try {
      for (const file of Array.from(fileList)) {
        const content = await fileToBase64(file);
        const res = await fetch(apiUrl(apiBasePath, "/media"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ directory, filename: file.name, content }),
        });
        const data = (await res.json()) as { path?: string; publish?: PublishResult; error?: string };
        if (!res.ok || !data.path) {
          setError(data.error ?? `Upload of ${file.name} failed.`);
          break;
        }
        uploaded++;
        if (data.publish) setPublishResult(data.publish);
      }
      if (uploaded > 0) {
        setNotice(`Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"}.`);
        setReloadKey((k) => k + 1);
      }
    } catch {
      setError("Upload failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function remove(file: MediaFile) {
    setError(null);
    setNotice(null);
    setConfirmingDelete(null);
    const res = await fetch(apiUrl(apiBasePath, "/media"), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: file.path, baseVersion: file.version }),
    });
    const data = (await res.json()) as { ok?: boolean; publish?: PublishResult; error?: string };
    if (!res.ok || !data.ok) {
      setError(data.error ?? "Delete failed.");
      return;
    }
    if (data.publish?.status === "draft") {
      setPublishResult(data.publish);
      setNotice("Deletion opened as a draft pull request — the file stays published until it's approved.");
    } else {
      setNotice("Deleted.");
    }
    setReloadKey((k) => k + 1);
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setNotice(`Copied ${path}`);
    } catch {
      setError("Couldn't access the clipboard — copy the path manually.");
    }
  }

  if (directories.length === 0) {
    return (
      <div>
        <a className="cimisy-crumb cimisy-link" href={basePath}>
          &larr; Content
        </a>
        <h1 className="cimisy-heading">Media</h1>
        <div className="cimisy-empty-state">
          <p className="cimisy-empty-state-title">No image directories configured</p>
          <p className="cimisy-muted" style={{ margin: 0 }}>
            Add a <code>fields.image()</code> field to a collection or singleton — its <code>directory</code> becomes
            browsable here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <a className="cimisy-crumb cimisy-link" href={basePath}>
        &larr; Content
      </a>
      <h1 className="cimisy-heading">Media</h1>

      <div className="cimisy-scan-controls">
        <div className="cimisy-field" style={{ marginBottom: 0, flex: "1 1 240px" }}>
          <label className="cimisy-label" htmlFor="cimisy-media-directory">
            Directory
          </label>
          <select
            id="cimisy-media-directory"
            className="cimisy-select"
            value={directory ?? ""}
            onChange={(e) => setDirectory(e.target.value)}
          >
            {directories.map((dir) => (
              <option key={dir} value={dir}>
                {dir}
              </option>
            ))}
          </select>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) void upload(e.target.files);
          }}
        />
        <button
          type="button"
          className="cimisy-btn cimisy-btn-primary"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? "Uploading…" : "Upload…"}
        </button>
      </div>

      {error && (
        <p className="cimisy-banner cimisy-banner-danger" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="cimisy-banner cimisy-banner-success" role="status">
          {notice}
        </p>
      )}
      {publishResult?.status === "draft" && publishResult.pullRequestUrl && (
        <p className="cimisy-banner cimisy-banner-warning" role="status">
          Media changes are on draft branch <code>{publishResult.branch}</code> —{" "}
          <a href={publishResult.pullRequestUrl} target="_blank" rel="noreferrer">
            review the pull request &rarr;
          </a>
        </p>
      )}

      <div
        className={`cimisy-dropzone${dragOver ? " is-drag-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
        }}
      >
        Drop images here to upload to <code>{directory}</code>
      </div>

      {files === null && !error ? (
        <div className="cimisy-media-grid" role="status" aria-label="Loading uploads">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="cimisy-skeleton" style={{ height: 148 }} />
          ))}
        </div>
      ) : files && files.length === 0 ? (
        <div className="cimisy-empty-state">
          <p className="cimisy-empty-state-title">Nothing here yet</p>
          <p className="cimisy-muted" style={{ margin: 0 }}>
            Upload images with the button above, or drag files onto the drop zone.
          </p>
        </div>
      ) : (
        <div className="cimisy-media-grid">
          {(files ?? []).map((file) => {
            const filename = file.path.split("/").pop() ?? file.path;
            return (
              <figure key={file.path} className="cimisy-media-card">
                <img src={thumbnailUrl(file.path)} alt={filename} loading="lazy" />
                <figcaption title={file.path}>{filename}</figcaption>
                <span className="cimisy-media-card-actions">
                  <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => void copyPath(file.path)}>
                    Copy path
                  </button>
                  {confirmingDelete === file.path ? (
                    <>
                      <button type="button" className="cimisy-btn cimisy-btn-danger" onClick={() => void remove(file)}>
                        Really delete?
                      </button>
                      <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => setConfirmingDelete(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="cimisy-btn cimisy-btn-ghost"
                      onClick={() => setConfirmingDelete(file.path)}
                      aria-label={`Delete ${filename}`}
                    >
                      Delete
                    </button>
                  )}
                </span>
              </figure>
            );
          })}
        </div>
      )}
    </div>
  );
}
