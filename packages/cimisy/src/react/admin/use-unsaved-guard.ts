"use client";

import { useEffect } from "react";

const CONFIRM_MESSAGE = "You have unsaved changes — leave without saving?";

/**
 * Blocks accidental navigation away from a form with unsaved edits. Two layers:
 *
 * - `beforeunload` covers everything that tears the document down — tab close,
 *   reload, and every plain `<a href>` navigation (which is all navigation in
 *   this admin; there's no client-side router transition to intercept).
 * - A capture-phase click listener on same-origin `<a>` clicks additionally
 *   shows a readable confirm (browsers ignore custom `beforeunload` text) and
 *   keeps the guard working if links are ever converted to next/link, whose
 *   soft navigations `beforeunload` doesn't see.
 */
export function useUnsavedChangesGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Required by Chrome for the prompt to appear; the text itself is ignored.
      e.returnValue = "";
    };

    const onClickCapture = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]");
      if (!anchor || anchor.getAttribute("target") === "_blank") return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (!window.confirm(CONFIRM_MESSAGE)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClickCapture, true);
    };
  }, [dirty]);
}
