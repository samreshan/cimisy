"use client";

import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { useRef, useState } from "react";
import type { BlockTypeManifest } from "../../../next/manifest.js";
import { BlockPropsEditor } from "../blocks-fallback.js";
import { apiUrl } from "../api.js";
import { fileToBase64, type MediaFile } from "../image-field.js";
import { CUSTOM_BLOCK_NODE_TYPE } from "./convert.js";

/**
 * Every cimisy-authored node (built-in or custom) carries these two
 * attributes: `blockId` is the stable BlockNode.id (survives reordering
 * and edits — Tiptap's own node identity is positional, not id-based, so
 * this is what convert.ts uses to preserve ids across the document), and
 * `blockType` is the *registry key* (e.g. "intro"), which is not always
 * the same as the node's own ProseMirror type name (which reflects
 * `kind`, e.g. "paragraph") — see convert.ts's blockToTiptapNode.
 */
function blockAttributes(defaultBlockType: string) {
  return {
    blockId: {
      default: null as string | null,
      parseHTML: (el: HTMLElement) => el.getAttribute("data-block-id"),
      renderHTML: (attrs: { blockId?: string | null }) => (attrs.blockId ? { "data-block-id": attrs.blockId } : {}),
    },
    blockType: {
      default: defaultBlockType,
      parseHTML: (el: HTMLElement) => el.getAttribute("data-block-type") ?? defaultBlockType,
      renderHTML: (attrs: { blockType?: string }) => (attrs.blockType ? { "data-block-type": attrs.blockType } : {}),
    },
  };
}

/** Replaces StarterKit's built-in paragraph (disabled via `.configure({ paragraph: false })`) purely to add blockId/blockType — otherwise behaves identically. */
export const CimisyParagraph = Node.create({
  name: "paragraph",
  group: "block",
  content: "inline*",
  addAttributes() {
    return blockAttributes("paragraph");
  },
  parseHTML() {
    return [{ tag: "p" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["p", mergeAttributes(HTMLAttributes), 0];
  },
});

/**
 * Replaces StarterKit's built-in heading. `content: "inline*"` with marks
 * allowed — cimisy's heading block schema carries the same rich
 * `content: InlineNode[]` as paragraphs (richified in 2.4; see
 * mdx/block-registry.ts), so bold/italic/link inside a heading round-trips
 * instead of silently vanishing on save.
 */
export const CimisyHeading = Node.create({
  name: "heading",
  group: "block",
  content: "inline*",
  defining: true,
  addOptions() {
    return { levels: [1, 2, 3, 4, 5, 6] as number[] };
  },
  addAttributes() {
    return { level: { default: 2 }, ...blockAttributes("heading") };
  },
  parseHTML() {
    return this.options.levels.map((level: number) => ({ tag: `h${level}`, attrs: { level } }));
  },
  renderHTML({ node, HTMLAttributes }) {
    const level: number = this.options.levels.includes(node.attrs.level) ? node.attrs.level : this.options.levels[0];
    return [`h${level}`, mergeAttributes(HTMLAttributes), 0];
  },
});

/** Fenced code block — plain text content, no marks, matches mdx/block-registry.ts's `code()` block (a language string + a code string, no inline formatting inside). */
export const CimisyCodeBlock = Node.create({
  name: "cimisyCodeBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes() {
    return { language: { default: null as string | null }, ...blockAttributes("code") };
  },
  parseHTML() {
    return [{ tag: "pre", preserveWhitespace: "full" as const }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const language = typeof node.attrs.language === "string" ? node.attrs.language : null;
    return ["pre", mergeAttributes(HTMLAttributes), ["code", language ? { class: `language-${language}` } : {}, 0]];
  },
});

function ImageNodeView({
  node,
  updateAttributes,
  extension,
}: {
  node: { attrs: Record<string, unknown> };
  updateAttributes: (attrs: Record<string, unknown>) => void;
  extension: { options: ImageBlockOptions };
}) {
  const { apiBasePath, draftRef, targetKey, slug, directoryByBlockType } = extension.options;
  const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const blockType = typeof node.attrs.blockType === "string" ? node.attrs.blockType : "image";
  const directory = directoryByBlockType[blockType];
  const [editingAlt, setEditingAlt] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [existing, setExisting] = useState<MediaFile[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function thumbnailUrl(path: string): string {
    const params = new URLSearchParams({ path, ...(draftRef ? { ref: draftRef } : {}) });
    return apiUrl(apiBasePath, `/media/raw?${params.toString()}`);
  }

  const thumbnailSrc = src ? thumbnailUrl(src) : null;

  async function handleFileSelected(file: File) {
    if (!directory || !slug) return;
    setUploading(true);
    setError(null);
    try {
      const content = await fileToBase64(file);
      const res = await fetch(apiUrl(apiBasePath, "/media"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetKey, slug, directory, filename: file.name, content }),
      });
      const data = (await res.json()) as { path?: string; error?: string };
      if (!res.ok || !data.path) {
        setError(data.error ?? "Upload failed.");
        return;
      }
      updateAttributes({ src: data.path });
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
    <NodeViewWrapper className="cimisy-editor-image-block" data-drag-handle>
      {error && (
        <p className="cimisy-banner cimisy-banner-danger" role="alert">
          {error}
        </p>
      )}
      {thumbnailSrc ? (
        <img src={thumbnailSrc} alt={alt} style={{ maxWidth: "100%", maxHeight: 320, borderRadius: 8, display: "block" }} />
      ) : (
        <div className="cimisy-empty">No image selected.</div>
      )}
      <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} contentEditable={false}>
        {!directory ? (
          <span className="cimisy-muted" style={{ fontSize: "0.85em" }}>
            Uploads aren&apos;t configured for this block — add a <code>directory</code> to its{" "}
            <code>blocks.image()</code> registration.
          </span>
        ) : !slug ? (
          <span className="cimisy-muted" style={{ fontSize: "0.85em" }}>
            Save the entry first to enable uploads.
          </span>
        ) : (
          <>
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
              {uploading ? "Uploading…" : src ? "Replace…" : "Upload…"}
            </button>
            <button type="button" className="cimisy-btn cimisy-btn-secondary" onClick={openBrowse}>
              Browse existing…
            </button>
          </>
        )}
      </div>
      {browsing && (
        <div className="cimisy-block-list" style={{ marginTop: 10 }} contentEditable={false}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span className="cimisy-muted" style={{ fontSize: "0.85em" }}>
              Existing uploads
            </span>
            <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => setBrowsing(false)}>
              Close
            </button>
          </div>
          {existing === null ? (
            <div className="cimisy-skeleton" style={{ height: 72 }} role="status" aria-label="Loading uploads" />
          ) : existing.length === 0 ? (
            <p className="cimisy-muted">No uploads yet.</p>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {existing.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => {
                    updateAttributes({ src: f.path });
                    setBrowsing(false);
                  }}
                  style={{ border: "none", background: "none", padding: 0, cursor: "pointer" }}
                  aria-label={`Use ${f.path.split("/").pop() ?? f.path}`}
                >
                  <img
                    src={thumbnailUrl(f.path)}
                    alt={f.path.split("/").pop() ?? f.path}
                    style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6 }}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        {editingAlt ? (
          <input
            className="cimisy-input"
            autoFocus
            value={alt}
            placeholder="Alt text"
            onChange={(e) => updateAttributes({ alt: e.target.value })}
            onBlur={() => setEditingAlt(false)}
          />
        ) : (
          <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => setEditingAlt(true)}>
            {alt ? `Alt: ${alt}` : "Set alt text…"}
          </button>
        )}
      </div>
    </NodeViewWrapper>
  );
}

interface ImageBlockOptions {
  apiBasePath: string;
  draftRef?: string;
  /** Same source of truth as sibling ImageField instances in the same entry form (see entry-form.tsx's FieldInput) — identifies the draft branch uploads should land on. */
  targetKey: string;
  /** Null for a brand-new, never-saved entry — gates uploads exactly like ImageField's own `slug` gate. */
  slug: string | null;
  /** Per-registry-key upload directory (see block-editor.tsx's directoryByBlockType) — keyed by the node's `blockType` attr, not by this node's fixed ProseMirror type name, since a project can register more than one "image"-kind block with different directories. */
  directoryByBlockType: Record<string, string | undefined>;
}

/**
 * Atom node (no editable inline content of its own — src/alt are edited
 * through the NodeView UI, not by typing into the document). Uploading a
 * *new* image into this block reuses the exact same POST /media flow as
 * ImageField (see react/admin/image-field.tsx — fileToBase64/MediaFile
 * are imported from there rather than reimplemented), and a "Browse
 * existing…" picker reuses the same GET /media flow. `apiBasePath`/
 * `draftRef`/`targetKey`/`slug`/`directoryByBlockType` are threaded in via
 * extension options at editor-creation time (see block-editor.tsx) since
 * NodeViews have no other way to reach outside the ProseMirror document.
 */
export const CimisyImage = Node.create<ImageBlockOptions>({
  name: "cimisyImage",
  group: "block",
  atom: true,
  addOptions() {
    return { apiBasePath: "", targetKey: "", slug: null, directoryByBlockType: {} };
  },
  addAttributes() {
    return { src: { default: "" }, alt: { default: "" }, ...blockAttributes("image") };
  },
  parseHTML() {
    return [{ tag: "div[data-cimisy-image]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-cimisy-image": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});

function CalloutNodeView({
  node,
  updateAttributes,
  extension,
}: {
  node: { attrs: Record<string, unknown> };
  updateAttributes: (attrs: Record<string, unknown>) => void;
  extension: { options: CalloutBlockOptions };
}) {
  const tone = typeof node.attrs.tone === "string" ? node.attrs.tone : "info";
  const blockType = typeof node.attrs.blockType === "string" ? node.attrs.blockType : "callout";
  const tones = extension.options.tonesByBlockType[blockType] ?? [tone];
  return (
    <NodeViewWrapper className={`cimisy-block-list cimisy-editor-callout cimisy-editor-callout-${tone}`} data-drag-handle>
      {/* The whole header is contentEditable={false}, not just the select:
          form controls nested directly inside a contentEditable region are
          unreliable for pointer interaction in some browsers — carving the
          header out of the editable region entirely is what makes the live
          tone select dependable (the same technique the image/custom-block
          NodeViews rely on by being atoms). */}
      <div className="cimisy-block-header" contentEditable={false}>
        <span>Callout</span>
        <select
          className="cimisy-select"
          style={{ width: "auto" }}
          value={tone}
          aria-label="Callout tone"
          onChange={(e) => updateAttributes({ tone: e.target.value })}
        >
          {tones.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <NodeViewContent />
    </NodeViewWrapper>
  );
}

interface CalloutBlockOptions {
  tonesByBlockType: Record<string, string[]>;
}

export const CimisyCallout = Node.create<CalloutBlockOptions>({
  name: "cimisyCallout",
  group: "block",
  content: "inline*",
  defining: true,
  addOptions() {
    return { tonesByBlockType: {} };
  },
  addAttributes() {
    return { tone: { default: "info" }, ...blockAttributes("callout") };
  },
  parseHTML() {
    return [{ tag: "div[data-cimisy-callout]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-cimisy-callout": node.attrs.tone }), 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutNodeView);
  },
});

function CustomBlockNodeView({
  node,
  updateAttributes,
  extension,
}: {
  node: { attrs: Record<string, unknown> };
  updateAttributes: (attrs: Record<string, unknown>) => void;
  extension: { options: CustomBlockOptions };
}) {
  const blockType = typeof node.attrs.blockType === "string" ? node.attrs.blockType : "";
  const typeDef = extension.options.manifestByName.get(blockType);
  const raw = typeof node.attrs.propsJson === "string" ? node.attrs.propsJson : "{}";
  let props: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    props = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    props = {};
  }

  return (
    <NodeViewWrapper className="cimisy-block" data-drag-handle contentEditable={false}>
      <div className="cimisy-block-header">
        <span>{typeDef?.label ?? blockType}</span>
      </div>
      {typeDef ? (
        <BlockPropsEditor
          typeDef={typeDef}
          props={props}
          onChange={(next: Record<string, unknown>) => updateAttributes({ propsJson: JSON.stringify(next) })}
        />
      ) : (
        <p className="cimisy-banner cimisy-banner-danger" style={{ margin: 0 }}>
          Unknown block type &quot;{blockType}&quot;
        </p>
      )}
    </NodeViewWrapper>
  );
}

interface CustomBlockOptions {
  manifestByName: Map<string, BlockTypeManifest>;
}

/**
 * The fallback for any block kind the rich editor doesn't have a
 * dedicated node for (a project-registered custom block, or a block type
 * from an older/different config) — an atom node carrying its raw props
 * as JSON, edited through the exact same props-form the pre-Tiptap
 * fallback editor used (blocks-fallback.tsx's BlockPropsEditor). This is
 * what makes the editor upgrade non-breaking for custom block registries:
 * nothing is ever silently dropped, just rendered less richly.
 */
export const CimisyCustomBlock = Node.create<CustomBlockOptions>({
  name: CUSTOM_BLOCK_NODE_TYPE,
  group: "block",
  atom: true,
  addOptions() {
    return { manifestByName: new Map() };
  },
  addAttributes() {
    return { propsJson: { default: "{}" }, ...blockAttributes("") };
  },
  parseHTML() {
    return [{ tag: "div[data-cimisy-custom-block]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-cimisy-custom-block": "" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CustomBlockNodeView);
  },
});
