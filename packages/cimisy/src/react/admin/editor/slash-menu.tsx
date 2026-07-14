"use client";

import { Extension } from "@tiptap/core";
import type { Editor, Range } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { BlockTypeManifest } from "../../../next/manifest.js";
import { CUSTOM_BLOCK_NODE_TYPE } from "./convert.js";

/** The Tiptap node JSON to insert when a block type is chosen from the slash menu — mirrors blocks-fallback.tsx's defaultPropsFor, but produces a Tiptap node directly since insertion goes straight into the editor, not through a BlockNode intermediate. */
function defaultNodeFor(typeDef: BlockTypeManifest): Record<string, unknown> {
  const blockId = crypto.randomUUID();
  const base = { blockId, blockType: typeDef.name };
  const uiOptions = typeDef.uiOptions ?? {};
  switch (typeDef.kind) {
    case "paragraph":
      return { type: "paragraph", attrs: base, content: [] };
    case "heading": {
      const levels = (uiOptions.levels as number[] | undefined) ?? [2];
      return { type: "heading", attrs: { ...base, level: levels[0] ?? 2 }, content: [] };
    }
    case "code": {
      const languages = uiOptions.languages as string[] | undefined;
      return { type: "cimisyCodeBlock", attrs: { ...base, language: languages?.[0] ?? null }, content: [] };
    }
    case "image":
      return { type: "cimisyImage", attrs: { ...base, src: "", alt: "" } };
    case "callout": {
      const tones = (uiOptions.tones as string[] | undefined) ?? ["info"];
      return { type: "cimisyCallout", attrs: { ...base, tone: tones[0] ?? "info" }, content: [] };
    }
    default:
      return { type: CUSTOM_BLOCK_NODE_TYPE, attrs: { ...base, propsJson: "{}" } };
  }
}

/** A short glyph per block kind for the slash menu's icon column — mirrors defaultNodeFor's switch above so every case there has a matching visual. Custom (config-registered) block types fall through to a generic mark since there's no way to know what they render. */
function iconFor(kind: string): string {
  switch (kind) {
    case "paragraph":
      return "¶";
    case "heading":
      return "H";
    case "code":
      return "<>";
    case "image":
      return "▢";
    case "callout":
      return "!";
    default:
      return "◆";
  }
}

interface SlashMenuListProps {
  items: BlockTypeManifest[];
  command: (item: BlockTypeManifest) => void;
}

interface SlashMenuListHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const SlashMenuList = forwardRef<SlashMenuListHandle, SlashMenuListProps>(({ items, command }, ref) => {
  const [selected, setSelected] = useState(0);

  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowDown") {
        setSelected((prev) => (prev + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "ArrowUp") {
        setSelected((prev) => (prev - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === "Enter") {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return <div className="cimisy-slash-menu cimisy-slash-menu-empty">No matching block type.</div>;
  }

  return (
    <div className="cimisy-slash-menu">
      {items.map((item, index) => (
        <button
          key={item.name}
          type="button"
          className={`cimisy-slash-menu-item ${index === selected ? "is-active" : ""}`}
          onMouseEnter={() => setSelected(index)}
          // Same fix as bubble-menu.tsx: a plain click lets the button's
          // mousedown steal focus/selection from the editor before the
          // range-replace command runs.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => command(item)}
        >
          <span className="cimisy-slash-menu-item-icon" aria-hidden="true">
            {iconFor(item.kind)}
          </span>
          {item.label}
        </button>
      ))}
    </div>
  );
});
SlashMenuList.displayName = "SlashMenuList";

function positionElement(el: HTMLElement, rect: DOMRect | null) {
  if (!rect) return;
  el.style.top = `${rect.bottom + window.scrollY + 4}px`;
  el.style.left = `${rect.left + window.scrollX}px`;
}

/** Builds the `/`-triggered block-insertion Extension for a given manifest's block types — a thin Extension.create wrapping @tiptap/suggestion, with a manually-positioned popup (no floating-ui/tippy dependency) since @tiptap/suggestion only supplies the trigger/filter logic, not rendering. */
export function createSlashMenuExtension(blockTypes: BlockTypeManifest[]) {
  return Extension.create({
    name: "cimisySlashCommand",
    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          char: "/",
          items: ({ query }: { query: string }) =>
            blockTypes.filter((t) => t.label.toLowerCase().includes(query.toLowerCase())).slice(0, 20),
          command: ({ editor, range, props }: { editor: Editor; range: Range; props: BlockTypeManifest }) => {
            editor.chain().focus().deleteRange(range).insertContent(defaultNodeFor(props)).run();
          },
          render: () => {
            let component: ReactRenderer<SlashMenuListHandle, SlashMenuListProps>;
            let element: HTMLElement;
            return {
              onStart: (props: SuggestionProps<BlockTypeManifest>) => {
                component = new ReactRenderer(SlashMenuList, {
                  props: { items: props.items, command: props.command },
                  editor: props.editor,
                });
                element = component.element as HTMLElement;
                element.style.position = "absolute";
                // Higher than any in-page chrome, including the sticky bottom action bar
                // (z-index 1 — see admin-theme.ts's .cimisy-action-bar).
                element.style.zIndex = "1000";
                // Mounted as a descendant of .cimisy-root, not document.body: admin-theme.ts's
                // colors are CSS custom properties scoped to .cimisy-root (deliberately, so they
                // can't leak into/out of the consumer's own site styles), and custom properties
                // only inherit through the real DOM tree — an element appended to document.body
                // can't see them, however it's visually positioned. Falls back to document.body
                // if .cimisy-root somehow isn't an ancestor (defensive, shouldn't happen).
                const mountTarget = props.editor.view.dom.closest(".cimisy-root") ?? document.body;
                mountTarget.appendChild(element);
                positionElement(element, props.clientRect?.() ?? null);
              },
              onUpdate: (props: SuggestionProps<BlockTypeManifest>) => {
                component.updateProps({ items: props.items, command: props.command });
                positionElement(element, props.clientRect?.() ?? null);
              },
              onKeyDown: (props: SuggestionKeyDownProps) => {
                if (props.event.key === "Escape") {
                  element.remove();
                  return true;
                }
                return component.ref?.onKeyDown(props) ?? false;
              },
              onExit: () => {
                element.remove();
                component.destroy();
              },
            };
          },
        }),
      ];
    },
  });
}
