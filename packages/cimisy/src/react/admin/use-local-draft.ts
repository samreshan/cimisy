"use client";

import { useEffect, useRef, useState } from "react";

export interface DraftSnapshot {
  values: Record<string, unknown>;
  savedAt: string;
}

/** One snapshot per entry (or singleton), keyed like the draft branches are — content key + slug. */
export function draftStorageKey(targetKey: string, slug: string | null): string {
  return `cimisy:draft:${targetKey}:${slug ?? "new"}`;
}

const DEBOUNCE_MS = 800;

function readSnapshot(storageKey: string): DraftSnapshot | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const snapshot = parsed as Partial<DraftSnapshot>;
    if (!snapshot.values || typeof snapshot.values !== "object" || typeof snapshot.savedAt !== "string") return null;
    return snapshot as DraftSnapshot;
  } catch {
    return null;
  }
}

function removeSnapshot(storageKey: string): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // localStorage unavailable (private mode quota, disabled) — autosave is best-effort.
  }
}

/**
 * Crash/close insurance for the entry and singleton forms: debounce-writes
 * every unsaved edit to localStorage, and on the next load of the same
 * entry offers the snapshot back before the form renders. The prompt is a
 * *gate* (the caller withholds the form until the user picks restore or
 * discard) rather than an in-place banner, deliberately: the Tiptap block
 * editor reads its document once on mount and never resyncs from props
 * (see block-editor.tsx), so restoring values into an already-mounted form
 * would silently not restore rich-text fields. Gating means the form —
 * editor included — first mounts with whichever values the user chose.
 *
 * This complements (never replaces) the beforeunload guard: the guard
 * stops navigation the browser can ask about; this survives what it
 * can't — crashes, force-quits, battery death.
 */
export function useLocalDraft(options: {
  storageKey: string;
  /** True once the server load finished and `values` holds the loaded (pre-edit) state — the moment a differing snapshot is worth offering. */
  ready: boolean;
  values: Record<string, unknown>;
  dirty: boolean;
}): {
  pendingDraft: DraftSnapshot | null;
  /** Accept the snapshot: returns its values for the caller to setValues(), keeps the snapshot on disk until the next real save. */
  restoreDraft: () => Record<string, unknown> | null;
  discardDraft: () => void;
  /** Call after a successful server save (or delete) — the snapshot is no longer newer than reality. */
  clearDraft: () => void;
} {
  const { storageKey, ready, values, dirty } = options;
  const [pendingDraft, setPendingDraft] = useState<DraftSnapshot | null>(null);
  // The freshest values, without making the debounced-write effect re-run
  // (and reset its timer) on every keystroke's values identity change.
  const valuesRef = useRef(values);
  valuesRef.current = values;

  useEffect(() => {
    if (!ready) return;
    const snapshot = readSnapshot(storageKey);
    if (!snapshot) return;
    // A snapshot identical to what the server already has is noise, not a
    // recovery — happens when a crash landed between save and cleanup.
    if (JSON.stringify(snapshot.values) === JSON.stringify(valuesRef.current)) {
      removeSnapshot(storageKey);
      return;
    }
    setPendingDraft(snapshot);
  }, [ready, storageKey]);

  useEffect(() => {
    if (!dirty || pendingDraft) return;
    const interval = window.setInterval(() => {
      try {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({ values: valuesRef.current, savedAt: new Date().toISOString() } satisfies DraftSnapshot),
        );
      } catch {
        // best-effort — see removeSnapshot
      }
    }, DEBOUNCE_MS);
    return () => window.clearInterval(interval);
  }, [dirty, pendingDraft, storageKey]);

  return {
    pendingDraft,
    restoreDraft: () => {
      if (!pendingDraft) return null;
      setPendingDraft(null);
      return pendingDraft.values;
    },
    discardDraft: () => {
      removeSnapshot(storageKey);
      setPendingDraft(null);
    },
    clearDraft: () => removeSnapshot(storageKey),
  };
}
