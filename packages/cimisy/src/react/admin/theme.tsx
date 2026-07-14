"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "cimisy-theme";

/**
 * Runs as an inline <script>, the first child inside .cimisy-root (see
 * app.tsx), so it executes synchronously while the browser is still
 * parsing that element — before first paint, and before React hydrates.
 * Without it, the root would render with no data-theme, the CSS's
 * prefers-color-scheme fallback would paint dark for a dark-OS user, and
 * useTheme's first effect (below) would then flip it — a visible flash.
 * Reading localStorage directly here (rather than waiting for React)
 * means a stored preference wins on the very first paint, not the second.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var s=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});var t=(s==="light"||s==="dark")?s:(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.currentScript.parentElement.setAttribute("data-theme",t);}catch(e){}})();`;

function rootEl(): HTMLElement | null {
  return document.querySelector(".cimisy-root");
}

/**
 * Mirrors the bootstrap script's own resolution (stored choice, else OS
 * preference) so the toggle's initial icon matches whatever the script
 * already painted, instead of assuming "light" and flipping visibly once
 * this effect runs.
 */
function resolveInitialTheme(): Theme {
  const attr = rootEl()?.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setTheme(resolveInitialTheme());
  }, []);

  function toggleTheme() {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      rootEl()?.setAttribute("data-theme", next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Private browsing / storage disabled: the toggle still works for the session, it just won't persist.
      }
      return next;
    });
  }

  return { theme, toggleTheme };
}

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      className="cimisy-theme-toggle"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13.5 9.4A5.6 5.6 0 0 1 6.6 2.5a5.8 5.8 0 1 0 6.9 6.9Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.4" />
          <path
            d="M8 1.4v1.6M8 13v1.6M14.6 8H13M3 8H1.4M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6 3.5 3.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
