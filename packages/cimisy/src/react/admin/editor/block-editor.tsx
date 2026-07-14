"use client";

import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useState } from "react";
import type { BlockNode } from "../../../config/fields/blocks.js";
import { isSafeUrl } from "../../../mdx/inline.js";
import type { BlockTypeManifest, FieldManifest } from "../../../next/manifest.js";
import { EditorBubbleMenu } from "./bubble-menu.js";
import { blocksToTiptapDoc, buildManifestLookup, tiptapDocToBlocks, type TiptapDoc } from "./convert.js";
import { DedupeBlockIds } from "./dedupe-block-ids.js";
import { CimisyCallout, CimisyCodeBlock, CimisyCustomBlock, CimisyHeading, CimisyImage, CimisyParagraph } from "./nodes.js";
import { createSlashMenuExtension } from "./slash-menu.js";

function tonesByBlockType(blockTypes: BlockTypeManifest[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const t of blockTypes) {
    if (t.kind === "callout") result[t.name] = (t.uiOptions?.tones as string[] | undefined) ?? ["info"];
  }
  return result;
}

export interface TiptapBlockEditorProps {
  field: FieldManifest;
  value: unknown;
  onChange: (value: BlockNode[]) => void;
  apiBasePath: string;
  draftRef?: string;
}

/**
 * The rich block editor for a `fields.blocks()` field: one continuous
 * Tiptap/ProseMirror document, with a dedicated node per built-in block
 * kind (see nodes.ts) and a generic fallback node (embedding the
 * pre-Tiptap props-form) for anything else. Content is read from `value`
 * only once, on mount — Tiptap owns the document after that, and changes
 * flow OUT via onUpdate, never back in via re-diffing props. This is the
 * standard controlled-vs-uncontrolled tradeoff every React rich-text
 * integration makes; the parent (entry-form.tsx) gives this component a
 * `key` tied to the entry's identity so switching entries remounts it
 * (and thus reloads content) instead of trying to imperatively resync a
 * live document.
 */
export function TiptapBlockEditor({ field, value, onChange, apiBasePath, draftRef }: TiptapBlockEditorProps) {
  const blockTypes = useMemo(() => field.blockTypes ?? [], [field.blockTypes]);
  const manifestByName = useMemo(() => buildManifestLookup(blockTypes), [blockTypes]);
  // Empty deps is intentional: captured once on mount, never resynced from
  // props afterward — see the component doc comment above. (This project
  // doesn't lint react-hooks/exhaustive-deps, so no disable directive is
  // needed here.)
  const initialDoc = useMemo(() => blocksToTiptapDoc(Array.isArray(value) ? (value as BlockNode[]) : [], manifestByName), []);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          paragraph: false,
          heading: false,
          codeBlock: false,
          blockquote: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          listKeymap: false,
          horizontalRule: false,
          underline: false,
          strike: false,
          hardBreak: false,
          link: false,
        }),
        CimisyParagraph,
        CimisyHeading,
        CimisyCodeBlock,
        CimisyImage.configure({ apiBasePath, draftRef }),
        CimisyCallout.configure({ tonesByBlockType: tonesByBlockType(blockTypes) }),
        CimisyCustomBlock.configure({ manifestByName }),
        Link.configure({ openOnClick: false, autolink: false, validate: isSafeUrl }),
        createSlashMenuExtension(blockTypes),
        DedupeBlockIds,
        // Renders inside whichever node is currently empty (see admin-theme.ts's
        // .is-editor-empty rule for the dashed-row styling) — the in-document
        // equivalent of the old static "Type / to insert a block" caption below
        // the editor, but shown exactly where the next block would land.
        Placeholder.configure({ placeholder: "/ Type to insert a block" }),
      ],
      content: initialDoc as never,
      immediatelyRender: false,
      onUpdate: ({ editor: ed }) => {
        onChange(tiptapDocToBlocks(ed.getJSON() as TiptapDoc));
      },
    },
    [],
  );

  useEffect(() => () => editor?.destroy(), [editor]);

  if (!editor) return <p className="cimisy-muted">Loading editor…</p>;

  return (
    <div className="cimisy-field">
      <label className="cimisy-label">{field.label}</label>
      <EditorBubbleMenu editor={editor} />
      <div className="cimisy-editor-shell">
        <EditorContent editor={editor} />
      </div>
      <BlockOutline editor={editor} manifestByName={manifestByName} />
    </div>
  );
}

interface OutlineItem {
  id: string;
  label: string;
}

/**
 * Block reordering/removal, deliberately implemented as a plain list with
 * move-up/move-down/remove buttons rather than in-editor pointer-drag
 * handles: dragging inside a live ProseMirror document needs careful
 * position-mapping/decoration work that's genuinely hard to get right
 * without interactive browser iteration, and a wrong implementation there
 * (dropped keystrokes, corrupted selections) is a much worse failure mode
 * than "reordering isn't drag-and-drop yet." Every operation here works
 * by reading/rewriting the whole top-level content array via
 * getJSON()/setContent(), the same safe, easy-to-verify approach
 * blocks-fallback.tsx's pre-Tiptap editor used for its up/down buttons.
 */
function BlockOutline({ editor, manifestByName }: { editor: Editor; manifestByName: Map<string, BlockTypeManifest> }) {
  const [items, setItems] = useState<OutlineItem[]>([]);

  useEffect(() => {
    function sync() {
      const doc = editor.getJSON() as TiptapDoc;
      setItems(
        (doc.content ?? []).map((node) => {
          const blockType = typeof node.attrs?.blockType === "string" ? node.attrs.blockType : node.type;
          const blockId = typeof node.attrs?.blockId === "string" ? node.attrs.blockId : "";
          return { id: blockId, label: manifestByName.get(blockType)?.label ?? blockType };
        }),
      );
    }
    sync();
    editor.on("update", sync);
    return () => {
      editor.off("update", sync);
    };
  }, [editor, manifestByName]);

  function withContent(mutate: (content: TiptapNode_[]) => TiptapNode_[]) {
    const doc = editor.getJSON() as TiptapDoc;
    const content = mutate([...(doc.content ?? [])]);
    editor.commands.setContent({ ...doc, content } as never, { emitUpdate: true });
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    withContent((content) => {
      const a = content[index];
      const b = content[target];
      if (!a || !b) return content;
      content[index] = b;
      content[target] = a;
      return content;
    });
  }

  function remove(index: number) {
    withContent((content) => content.filter((_, i) => i !== index));
  }

  if (items.length <= 1) return null;

  return (
    <div className="cimisy-block-list" style={{ marginTop: 12 }}>
      {items.map((item, index) => (
        <div key={item.id || index} className="cimisy-block-outline-item">
          <span className="cimisy-muted" style={{ fontSize: "0.85em" }}>
            {item.label}
          </span>
          <span className="cimisy-block-controls">
            <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => move(index, -1)} disabled={index === 0}>
              &uarr;
            </button>
            <button
              type="button"
              className="cimisy-btn cimisy-btn-ghost"
              onClick={() => move(index, 1)}
              disabled={index === items.length - 1}
            >
              &darr;
            </button>
            <button type="button" className="cimisy-btn cimisy-btn-ghost" onClick={() => remove(index)}>
              Remove
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

// Local alias so BlockOutline's helper doesn't need a second import line for the same shape convert.ts already exports as TiptapNode.
type TiptapNode_ = TiptapDoc["content"][number];
