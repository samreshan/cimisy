"use client";

import type { Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { useState } from "react";
import { isSafeUrl } from "../../../mdx/inline.js";

/** Every bubble-menu button needs this: a plain `onClick` lets the button's own `mousedown` fire first, which steals focus from the ProseMirror editor and collapses/loses the text selection *before* the click handler's command ever runs — the command then applies to a stale or empty selection, silently dropping the selected text on Enter/split shortly after (found via live browser testing, not something a unit test would catch). Suppressing the button's mousedown keeps the editor's selection exactly as the user made it. */
function preventMouseDownStealingSelection(e: React.MouseEvent) {
  e.preventDefault();
}

/**
 * Bold/italic/inline-code/link, shown on text selection (BubbleMenu's
 * default `shouldShow` already restricts this to a non-empty selection).
 * Applies inside any node that allows marks (paragraph, callout) — inside
 * heading, which disallows marks entirely (see nodes.ts's CimisyHeading),
 * the toggle commands simply no-op against the schema rather than doing
 * anything visible, which is the honest behavior given cimisy's heading
 * block has never supported rich text.
 */
export function EditorBubbleMenu({ editor }: { editor: Editor }) {
  const [linkInputOpen, setLinkInputOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");

  function openLinkInput() {
    const attrs = editor.getAttributes("link") as { href?: string };
    setLinkValue(attrs.href ?? "");
    setLinkInputOpen(true);
  }

  function applyLink() {
    const href = linkValue.trim();
    if (!href) {
      editor.chain().focus().unsetMark("link").run();
    } else if (isSafeUrl(href)) {
      editor.chain().focus().setMark("link", { href }).run();
    }
    setLinkInputOpen(false);
  }

  return (
    <BubbleMenu editor={editor} className="cimisy-bubble-menu">
      {linkInputOpen ? (
        <div style={{ display: "flex", gap: 4 }} onMouseDown={preventMouseDownStealingSelection}>
          <input
            className="cimisy-input"
            autoFocus
            style={{ width: 220 }}
            value={linkValue}
            placeholder="https://…"
            onChange={(e) => setLinkValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyLink();
              }
              if (e.key === "Escape") setLinkInputOpen(false);
            }}
          />
          <button type="button" className="cimisy-btn cimisy-btn-secondary" onClick={applyLink}>
            Set
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            className={`cimisy-bubble-btn ${editor.isActive("bold") ? "is-active" : ""}`}
            onMouseDown={preventMouseDownStealingSelection}
            onClick={() => editor.chain().focus().toggleMark("bold").run()}
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            className={`cimisy-bubble-btn ${editor.isActive("italic") ? "is-active" : ""}`}
            onMouseDown={preventMouseDownStealingSelection}
            onClick={() => editor.chain().focus().toggleMark("italic").run()}
          >
            <em>I</em>
          </button>
          <button
            type="button"
            className={`cimisy-bubble-btn ${editor.isActive("code") ? "is-active" : ""}`}
            onMouseDown={preventMouseDownStealingSelection}
            onClick={() => editor.chain().focus().toggleMark("code").run()}
          >
            {"</>"}
          </button>
          <button
            type="button"
            className={`cimisy-bubble-btn ${editor.isActive("link") ? "is-active" : ""}`}
            onMouseDown={preventMouseDownStealingSelection}
            onClick={openLinkInput}
          >
            Link
          </button>
        </>
      )}
    </BubbleMenu>
  );
}
