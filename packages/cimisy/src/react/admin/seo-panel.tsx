"use client";

import { useState } from "react";
import type { FieldManifest } from "../../next/manifest.js";
import { ImageField } from "./image-field.js";

interface SeoValueLike {
  title?: string;
  description?: string;
  canonical?: string;
  ogImage?: string | null;
  noindex?: boolean;
}

/** Soft targets, not limits — search engines truncate around these lengths, so the counter turns amber past them rather than blocking input. */
const TITLE_TARGET = 60;
const DESCRIPTION_TARGET = 160;

function asSeoValue(value: unknown): SeoValueLike {
  return value && typeof value === "object" ? (value as SeoValueLike) : {};
}

/**
 * The fields.seo() editor: a collapsed-by-default panel (SEO is
 * secondary to the content itself) summarizing whether it's been filled
 * in, expanding to title/description with character-count hints, a
 * canonical URL input, the og-image picker (the standard ImageField when
 * the field configures an imageDirectory, a plain path input otherwise),
 * and a noindex toggle. The whole panel edits one nested SeoValue object
 * through the parent form's onChange.
 */
export function SeoPanel({
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
  const [open, setOpen] = useState(false);
  const seo = asSeoValue(value);

  function set<K extends keyof SeoValueLike>(key: K, v: SeoValueLike[K]) {
    const next: SeoValueLike = { ...seo, [key]: v };
    // Empty inputs drop the property entirely (rather than storing "") so
    // fallbacks in createMetadata keep applying.
    if (v === "" || v === undefined || v === null) delete next[key];
    onChange(next);
  }

  const filled = [seo.title, seo.description, seo.canonical, seo.ogImage].filter(Boolean).length;

  return (
    <div className="cimisy-field cimisy-seo-panel">
      <button type="button" className="cimisy-seo-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="cimisy-label" style={{ marginBottom: 0 }}>
          {field.label}
        </span>
        <span className="cimisy-muted" style={{ fontSize: "0.85em" }}>
          {filled === 0 ? "not set" : `${filled} field${filled === 1 ? "" : "s"} set`}
          {seo.noindex ? " · noindex" : ""}
          {open ? " ▾" : " ▸"}
        </span>
      </button>
      {open && (
        <div className="cimisy-seo-body">
          <CountedInput
            id={`${field.name}-title`}
            label="SEO title"
            value={seo.title ?? ""}
            target={TITLE_TARGET}
            onChange={(v) => set("title", v)}
          />
          <CountedInput
            id={`${field.name}-description`}
            label="Meta description"
            value={seo.description ?? ""}
            target={DESCRIPTION_TARGET}
            onChange={(v) => set("description", v)}
            multiline
          />
          <div className="cimisy-field">
            <label className="cimisy-label" htmlFor={`${field.name}-canonical`}>
              Canonical URL
            </label>
            <input
              id={`${field.name}-canonical`}
              className="cimisy-input"
              type="text"
              placeholder="https://… or /path"
              value={seo.canonical ?? ""}
              onChange={(e) => set("canonical", e.target.value)}
            />
          </div>
          {field.directory ? (
            <ImageField
              field={{ name: `${field.name}-og-image`, kind: "image", label: "Social image (og:image)", directory: field.directory }}
              value={seo.ogImage ?? null}
              onChange={(v) => set("ogImage", v)}
              apiBasePath={apiBasePath}
              targetKey={targetKey}
              slug={slug}
              draftRef={draftRef}
            />
          ) : (
            <div className="cimisy-field">
              <label className="cimisy-label" htmlFor={`${field.name}-og-image`}>
                Social image path (og:image)
              </label>
              <input
                id={`${field.name}-og-image`}
                className="cimisy-input"
                type="text"
                value={seo.ogImage ?? ""}
                onChange={(e) => set("ogImage", e.target.value)}
              />
            </div>
          )}
          <label className="cimisy-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={seo.noindex ?? false} onChange={(e) => set("noindex", e.target.checked || undefined)} />
            Hide from search engines (noindex)
          </label>
        </div>
      )}
    </div>
  );
}

function CountedInput({
  id,
  label,
  value,
  target,
  onChange,
  multiline,
}: {
  id: string;
  label: string;
  value: string;
  target: number;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  const over = value.length > target;
  return (
    <div className="cimisy-field">
      <label className="cimisy-label" htmlFor={id}>
        {label}{" "}
        <span className="cimisy-muted" style={{ color: over ? "var(--cimisy-warning)" : undefined }}>
          ({value.length}/{target})
        </span>
      </label>
      {multiline ? (
        <textarea id={id} className="cimisy-input" rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} className="cimisy-input" type="text" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}
