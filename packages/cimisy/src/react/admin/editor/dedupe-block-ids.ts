import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * ProseMirror's native editing commands (pressing Enter to split a
 * paragraph, duplicating a node, undo/redo) copy a node's attrs —
 * including our custom `blockId` — to both resulting nodes rather than
 * generating a fresh one for the new half. Left alone, this produces
 * duplicate blockIds across sibling top-level blocks, which surfaces as a
 * React "two children with the same key" warning wherever the UI keys a
 * list by blockId (see block-editor.tsx's BlockOutline) and can cause
 * React to reconcile the wrong DOM node onto the wrong block. This is a
 * real bug, not cosmetic — found via live browser testing (pressing Enter
 * then using the slash menu), not something the pure convert.ts unit
 * tests could catch, since they never exercise ProseMirror's own
 * transform commands.
 *
 * Fixed generally (not by special-casing Enter/split) via an
 * appendTransaction hook: after every doc-changing transaction, walk the
 * top-level blocks and reassign a fresh id to any blockId that's missing
 * or already used by an earlier sibling. This covers split, paste,
 * duplicate, and anything else uniformly.
 */
export const DedupeBlockIds = Extension.create({
  name: "cimisyDedupeBlockIds",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("cimisyDedupeBlockIds"),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const seen = new Set<string>();
          let tr: ReturnType<typeof newState.tr.setNodeMarkup> | undefined;
          newState.doc.forEach((node, pos) => {
            const currentId = typeof node.attrs.blockId === "string" ? node.attrs.blockId : null;
            if (currentId && !seen.has(currentId)) {
              seen.add(currentId);
              return;
            }
            const freshId = crypto.randomUUID();
            seen.add(freshId);
            tr = (tr ?? newState.tr).setNodeMarkup(pos, undefined, { ...node.attrs, blockId: freshId });
          });
          return tr ?? null;
        },
      }),
    ];
  },
});
