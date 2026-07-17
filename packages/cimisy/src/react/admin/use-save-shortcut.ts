"use client";

import { useEffect, useRef } from "react";

/**
 * Cmd/Ctrl+S saves instead of triggering the browser's save-page dialog —
 * the one keyboard shortcut every editor's muscle memory expects. Bound on
 * window (capture isn't needed; ProseMirror doesn't claim mod+S) and kept
 * behind a ref so re-renders don't churn the listener.
 */
export function useSaveShortcut(onSave: () => void): void {
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSaveRef.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
