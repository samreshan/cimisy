/**
 * A single injected stylesheet rather than a CSS file import: cimisy ships
 * as a plain 1:1-transpiled package (see tsup.config.ts's bundle: false),
 * so it can't rely on the consumer's bundler resolving `import "./x.css"`
 * from node_modules — that's fragile across Next.js versions/bundlers.
 * Rendering one <style> tag from AdminApp works everywhere with zero
 * config. Everything is scoped under .cimisy-root so it can't leak into
 * (or be leaked into by) the consumer's own site styles.
 *
 * Tokens mirror brand/design-system/foundations/colors.html (Cimisy Blue,
 * sampled from the logo, plus the same-hue "ink" neutral ramp) — that file
 * is the source of truth if these two drift. Dark mode is a deliberate
 * remap (surfaces step up, blue shifts up-ramp for text/icons, solid fills
 * stay put), not a naive invert; see that file's "dark mapping" panel.
 */
export const ADMIN_THEME_CSS = `
.cimisy-root {
  --cimisy-bg: #f6f7f8;
  --cimisy-surface: #ffffff;
  --cimisy-surface-2: #eeeff2;
  --cimisy-text: #1b1d22;
  --cimisy-text-soft: #5e6678;
  --cimisy-text-faint: #a4a9b7;
  --cimisy-border: #e0e2e6;
  --cimisy-border-strong: #c6c9d2;
  --cimisy-accent: #2b5acf;
  --cimisy-accent-hover: #2048ad;
  --cimisy-accent-text: #2048ad;
  --cimisy-accent-soft: #eef2fb;
  --cimisy-accent-soft-2: #d9e2f7;
  --cimisy-on-accent: #ffffff;
  --cimisy-success: #218352;
  --cimisy-success-soft: #e8f8f0;
  --cimisy-warning: #8b6523;
  --cimisy-warning-soft: #f8f2e8;
  --cimisy-danger: #a33929;
  --cimisy-danger-soft: #f8eae8;
  --cimisy-shadow-sm: 0 1px 2px rgba(13, 30, 72, 0.05), 0 2px 8px rgba(13, 30, 72, 0.05);
  --cimisy-shadow-md: 0 2px 4px rgba(13, 30, 72, 0.06), 0 8px 24px rgba(13, 30, 72, 0.1);
  --cimisy-shadow-lg: 0 4px 8px rgba(13, 30, 72, 0.08), 0 18px 48px rgba(13, 30, 72, 0.16);
  --cimisy-code-bg: #0d1e48;
  --cimisy-code-text: #d9e2f7;
  --cimisy-code-text-soft: #809de5;

  --cimisy-radius-sm: 8px;
  --cimisy-radius-md: 10px;
  --cimisy-radius-lg: 14px;
  --cimisy-radius-xl: 18px;
  --cimisy-radius-pill: 999px;
  --cimisy-font-display: ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", "Segoe UI", system-ui, sans-serif;

  color-scheme: light;
  color: var(--cimisy-text);
  background: var(--cimisy-bg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  max-width: 960px;
  margin: 0 auto;
  padding: 40px 24px 80px;
  box-sizing: border-box;
}
.cimisy-root[data-theme="dark"] {
  color-scheme: dark;
  --cimisy-bg: #1b1d22;
  --cimisy-surface: #24262d;
  --cimisy-surface-2: #2f323b;
  --cimisy-text: #eeeff2;
  --cimisy-text-soft: #a4a9b7;
  --cimisy-text-faint: #6b7284;
  --cimisy-border: #33363f;
  --cimisy-border-strong: #434956;
  --cimisy-accent-hover: #4e76da;
  --cimisy-accent-text: #93aeed;
  --cimisy-accent-soft: #1d2a4a;
  --cimisy-accent-soft-2: #263a68;
  --cimisy-success: #5cc492;
  --cimisy-success-soft: #143526;
  --cimisy-warning: #d3a355;
  --cimisy-warning-soft: #352b15;
  --cimisy-danger: #e2907f;
  --cimisy-danger-soft: #3a1a12;
  --cimisy-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.35);
  --cimisy-shadow-md: 0 4px 16px rgba(0, 0, 0, 0.4);
  --cimisy-shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.55);
}
/* Progressive-enhancement fallback for the instant before the bootstrap script (see admin/theme.ts)
   sets data-theme, and for environments where it can't run at all. The script's explicit choice
   always wins once it runs, because [data-theme="dark"]/[data-theme="light"] are more specific. */
@media (prefers-color-scheme: dark) {
  .cimisy-root:not([data-theme="light"]) {
    color-scheme: dark;
    --cimisy-bg: #1b1d22;
    --cimisy-surface: #24262d;
    --cimisy-surface-2: #2f323b;
    --cimisy-text: #eeeff2;
    --cimisy-text-soft: #a4a9b7;
    --cimisy-text-faint: #6b7284;
    --cimisy-border: #33363f;
    --cimisy-border-strong: #434956;
    --cimisy-accent-hover: #4e76da;
    --cimisy-accent-text: #93aeed;
    --cimisy-accent-soft: #1d2a4a;
    --cimisy-accent-soft-2: #263a68;
    --cimisy-success: #5cc492;
    --cimisy-success-soft: #143526;
    --cimisy-warning: #d3a355;
    --cimisy-warning-soft: #352b15;
    --cimisy-danger: #e2907f;
    --cimisy-danger-soft: #3a1a12;
    --cimisy-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.35);
    --cimisy-shadow-md: 0 4px 16px rgba(0, 0, 0, 0.4);
    --cimisy-shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.55);
  }
}
.cimisy-root,
.cimisy-root *,
.cimisy-root *::before,
.cimisy-root *::after {
  box-sizing: inherit;
}
.cimisy-root * {
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}

.cimisy-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 28px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--cimisy-border);
  flex-wrap: wrap;
}
.cimisy-nav-brand-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--cimisy-font-display);
  font-weight: 650;
  font-size: 1.05em;
  color: var(--cimisy-text);
  text-decoration: none;
  letter-spacing: -0.01em;
}
.cimisy-nav-links {
  display: flex;
  gap: 4px;
  flex: 1;
}
.cimisy-nav-link {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--cimisy-text-soft);
  text-decoration: none;
  font-weight: 600;
  font-size: 0.9em;
  padding: 7px 11px;
  border-radius: var(--cimisy-radius-sm);
}
.cimisy-nav-link:hover {
  background: var(--cimisy-surface-2);
  color: var(--cimisy-text);
}
.cimisy-nav-link.is-active {
  background: var(--cimisy-accent-soft);
  color: var(--cimisy-accent-text);
}
.cimisy-nav-link-count {
  background: var(--cimisy-accent);
  color: var(--cimisy-on-accent);
  font-size: 0.72em;
  font-weight: 700;
  border-radius: var(--cimisy-radius-pill);
  padding: 1px 6px;
  line-height: 1.4;
}
.cimisy-nav-user {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.85em;
  color: var(--cimisy-text-soft);
}

.cimisy-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--cimisy-accent-soft-2);
  color: var(--cimisy-accent-text);
  font-size: 0.72em;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  text-transform: uppercase;
}

.cimisy-theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--cimisy-border);
  background: var(--cimisy-surface);
  color: var(--cimisy-text-soft);
  cursor: pointer;
}
.cimisy-theme-toggle:hover {
  border-color: var(--cimisy-accent);
  color: var(--cimisy-accent-text);
}
.cimisy-theme-toggle svg {
  width: 15px;
  height: 15px;
}

.cimisy-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--cimisy-surface-2);
  color: var(--cimisy-text);
  font-weight: 650;
  font-size: 0.78em;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 4px 10px;
  border-radius: var(--cimisy-radius-pill);
  white-space: nowrap;
}
.cimisy-badge-accent {
  background: var(--cimisy-accent);
  color: var(--cimisy-on-accent);
}
.cimisy-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.cimisy-badge-dot-warning { background: var(--cimisy-warning); }
.cimisy-badge-dot-success { background: var(--cimisy-success); }
.cimisy-badge-dot-danger { background: var(--cimisy-danger); }
.cimisy-badge-dot-accent { background: var(--cimisy-accent); }

.cimisy-chip-branch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: var(--cimisy-radius-sm);
  background: var(--cimisy-surface-2);
  color: var(--cimisy-text-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.78em;
  white-space: nowrap;
}

.cimisy-card.cimisy-team-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.cimisy-team-name {
  font-weight: 600;
}

.cimisy-crumb {
  display: inline-block;
  margin-bottom: 14px;
  font-size: 0.9em;
}

.cimisy-crumb-trail {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
  font-size: 0.88em;
  flex-wrap: wrap;
}
.cimisy-crumb-trail a {
  color: var(--cimisy-accent-text);
  text-decoration: none;
  font-weight: 600;
}
.cimisy-crumb-trail a:hover {
  text-decoration: underline;
}
.cimisy-crumb-trail-sep {
  color: var(--cimisy-text-faint);
}
.cimisy-crumb-trail-here {
  color: var(--cimisy-text-soft);
  font-weight: 500;
}

.cimisy-heading {
  font-family: var(--cimisy-font-display);
  font-size: 1.7em;
  font-weight: 600;
  letter-spacing: -0.01em;
  margin: 0 0 22px;
  color: var(--cimisy-text);
}

.cimisy-subheading {
  font-family: var(--cimisy-font-display);
  font-size: 1.05em;
  font-weight: 600;
  margin: 0 0 10px;
  color: var(--cimisy-text);
}

.cimisy-muted {
  color: var(--cimisy-text-soft);
}

.cimisy-link {
  color: var(--cimisy-accent-text);
  text-decoration: none;
  font-weight: 550;
}
.cimisy-link:hover {
  color: var(--cimisy-accent-hover);
  text-decoration: underline;
}

.cimisy-list {
  list-style: none;
  margin: 0 0 20px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cimisy-card {
  display: block;
  background: var(--cimisy-surface);
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-lg);
  padding: 14px 16px;
  box-shadow: var(--cimisy-shadow-sm);
  color: var(--cimisy-text);
  text-decoration: none;
}
a.cimisy-card:hover {
  border-color: var(--cimisy-accent);
  box-shadow: var(--cimisy-shadow-md);
  transform: translateY(-1px);
}
.cimisy-card-error {
  border-color: var(--cimisy-danger);
  background: var(--cimisy-danger-soft);
  color: var(--cimisy-danger);
}

.cimisy-empty {
  color: var(--cimisy-text-soft);
  background: var(--cimisy-surface-2);
  border-radius: var(--cimisy-radius-md);
  padding: 14px 16px;
  margin: 0;
}

.cimisy-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: inherit;
  font-weight: 600;
  font-size: 0.92em;
  text-decoration: none;
  border-radius: var(--cimisy-radius-md);
  border: 1px solid transparent;
  padding: 9px 16px;
  cursor: pointer;
}
.cimisy-btn:focus-visible {
  outline: 2px solid var(--cimisy-accent);
  outline-offset: 2px;
}
.cimisy-btn:active {
  transform: translateY(1px);
}
.cimisy-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.cimisy-btn-primary {
  background: var(--cimisy-accent);
  border-color: var(--cimisy-accent);
  color: var(--cimisy-on-accent);
}
.cimisy-btn-primary:hover:not(:disabled) {
  background: var(--cimisy-accent-hover);
  border-color: var(--cimisy-accent-hover);
}
.cimisy-btn-secondary {
  background: var(--cimisy-surface);
  border-color: var(--cimisy-border-strong);
  color: var(--cimisy-text);
}
.cimisy-btn-secondary:hover:not(:disabled) {
  border-color: var(--cimisy-accent);
  color: var(--cimisy-accent-text);
}
.cimisy-btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--cimisy-text-soft);
  padding: 6px 9px;
  font-size: 0.85em;
}
.cimisy-btn-ghost:hover:not(:disabled) {
  background: var(--cimisy-surface-2);
  color: var(--cimisy-text);
}
.cimisy-btn-danger {
  background: var(--cimisy-surface);
  border-color: var(--cimisy-danger);
  color: var(--cimisy-danger);
}
.cimisy-btn-danger:hover:not(:disabled) {
  background: var(--cimisy-danger);
  border-color: var(--cimisy-danger);
  color: var(--cimisy-on-accent);
}

.cimisy-field {
  margin-bottom: 18px;
}
.cimisy-label {
  display: block;
  font-size: 0.85em;
  font-weight: 600;
  color: var(--cimisy-text-soft);
  margin-bottom: 6px;
}
.cimisy-input,
.cimisy-textarea,
.cimisy-select {
  width: 100%;
  font: inherit;
  font-size: 0.95em;
  color: var(--cimisy-text);
  background: var(--cimisy-surface);
  border: 1px solid var(--cimisy-border-strong);
  border-radius: var(--cimisy-radius-md);
  padding: 9px 12px;
}
.cimisy-textarea {
  resize: vertical;
}
.cimisy-input:focus,
.cimisy-textarea:focus,
.cimisy-select:focus {
  outline: none;
  border-color: var(--cimisy-accent);
  box-shadow: 0 0 0 3px var(--cimisy-accent-soft-2);
}
.cimisy-input[type="text"].cimisy-input-mono,
.cimisy-textarea-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.cimisy-required-marker {
  color: var(--cimisy-danger);
  margin-left: 3px;
}
.cimisy-field-error {
  color: var(--cimisy-danger);
  font-size: 0.85em;
  margin: 6px 0 0;
}
.cimisy-input[aria-invalid="true"],
.cimisy-textarea[aria-invalid="true"] {
  border-color: var(--cimisy-danger);
}

/* The entry's title field (collection.slugField) rendered as a borderless hero, not a boxed
   input — the one field that reads as "the document", the way the reference layout treats it. */
.cimisy-title-field {
  margin-bottom: 22px;
}
.cimisy-title-label {
  display: block;
  font-size: 0.72em;
  font-weight: 650;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cimisy-text-faint);
  margin-bottom: 8px;
}
.cimisy-title-input {
  display: block;
  width: 100%;
  border: none;
  background: transparent;
  padding: 0;
  font-family: var(--cimisy-font-display);
  font-size: 2em;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--cimisy-text);
}
.cimisy-title-input::placeholder {
  color: var(--cimisy-text-faint);
}
.cimisy-title-input:focus {
  outline: none;
}

.cimisy-banner {
  border-radius: var(--cimisy-radius-md);
  padding: 10px 14px;
  margin-bottom: 18px;
  font-size: 0.9em;
}
.cimisy-banner-danger {
  background: var(--cimisy-danger-soft);
  color: var(--cimisy-danger);
}
.cimisy-banner-success {
  background: var(--cimisy-success-soft);
  color: var(--cimisy-success);
}
.cimisy-banner-warning {
  background: var(--cimisy-warning-soft);
  color: var(--cimisy-warning);
}
.cimisy-banner a {
  color: inherit;
  font-weight: 650;
}

.cimisy-block-list {
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-lg);
  padding: 12px;
  background: var(--cimisy-surface-2);
  margin-top: 6px;
}
.cimisy-block {
  background: var(--cimisy-surface);
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-md);
  padding: 12px;
  margin-bottom: 10px;
}
.cimisy-block:last-child {
  margin-bottom: 0;
}
.cimisy-block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.78em;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--cimisy-text-soft);
  margin-bottom: 8px;
}
.cimisy-block-controls {
  display: flex;
  gap: 2px;
}

.cimisy-panel {
  margin-top: 32px;
  padding-top: 20px;
  border-top: 1px solid var(--cimisy-border);
}
.cimisy-history-item {
  font-size: 0.85em;
  color: var(--cimisy-text-soft);
  padding: 8px 0;
  border-bottom: 1px solid var(--cimisy-border);
}
.cimisy-history-item:last-child {
  border-bottom: none;
}
.cimisy-history-item code {
  background: var(--cimisy-surface-2);
  border-radius: var(--cimisy-radius-sm);
  padding: 1px 5px;
  font-size: 0.92em;
}

.cimisy-signin {
  text-align: center;
  padding: 64px 24px;
}

/* --- Tiptap rich block editor (M6) --- */

.cimisy-editor-shell {
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-lg);
  background: var(--cimisy-surface);
  padding: 14px 18px;
}
.cimisy-editor-shell:focus-within {
  border-color: var(--cimisy-accent);
}
.cimisy-editor-shell .ProseMirror {
  min-height: 160px;
  outline: none;
  font-size: 0.95em;
  line-height: 1.6;
}
.cimisy-editor-shell .ProseMirror p {
  margin: 0 0 0.8em;
}
.cimisy-editor-shell .ProseMirror p:last-child {
  margin-bottom: 0;
}
.cimisy-editor-shell .ProseMirror h1,
.cimisy-editor-shell .ProseMirror h2,
.cimisy-editor-shell .ProseMirror h3,
.cimisy-editor-shell .ProseMirror h4,
.cimisy-editor-shell .ProseMirror h5,
.cimisy-editor-shell .ProseMirror h6 {
  font-family: var(--cimisy-font-display);
  margin: 0.6em 0 0.4em;
  font-weight: 600;
  color: var(--cimisy-text);
}
.cimisy-editor-shell .ProseMirror pre {
  background: var(--cimisy-code-bg);
  color: var(--cimisy-code-text);
  border-radius: var(--cimisy-radius-md);
  padding: 12px 14px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.88em;
}
.cimisy-editor-shell .ProseMirror code {
  background: var(--cimisy-surface-2);
  border-radius: var(--cimisy-radius-sm);
  padding: 1px 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.cimisy-editor-shell .ProseMirror pre code {
  background: none;
  color: inherit;
  padding: 0;
}
.cimisy-editor-shell .ProseMirror a {
  color: var(--cimisy-accent-text);
}
/* The "/ Type to insert a block" row: @tiptap/extension-placeholder adds
   is-editor-empty + data-placeholder to whichever node is currently empty
   and focused (see block-editor.tsx's Placeholder.configure) — styled here
   as a dashed insertion row rather than plain gray text, so an empty block
   reads as an affordance instead of a blank line. float+height:0 (Tiptap's
   own recipe) keeps it from disturbing the empty node's own box, which is
   what the caret is actually positioned against. */
.cimisy-editor-shell .ProseMirror .is-editor-empty::before {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--cimisy-text-faint);
  font-size: 0.92em;
  padding: 8px 12px;
  margin-top: -8px;
  border: 1px dashed var(--cimisy-border-strong);
  border-radius: var(--cimisy-radius-md);
  white-space: nowrap;
}

.cimisy-bubble-menu {
  display: flex;
  gap: 2px;
  background: var(--cimisy-text);
  border-radius: var(--cimisy-radius-md);
  padding: 4px;
  box-shadow: var(--cimisy-shadow-md);
}
.cimisy-bubble-btn {
  background: transparent;
  border: none;
  color: var(--cimisy-bg);
  border-radius: var(--cimisy-radius-sm);
  padding: 5px 9px;
  font: inherit;
  font-size: 0.85em;
  cursor: pointer;
}
.cimisy-bubble-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}
.cimisy-bubble-btn.is-active {
  background: var(--cimisy-accent);
  color: var(--cimisy-on-accent);
}

.cimisy-slash-menu {
  background: var(--cimisy-surface);
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-md);
  box-shadow: var(--cimisy-shadow-md);
  padding: 4px;
  min-width: 190px;
  max-height: 260px;
  overflow-y: auto;
}
.cimisy-slash-menu-empty {
  padding: 8px 10px;
  color: var(--cimisy-text-soft);
  font-size: 0.85em;
}
.cimisy-slash-menu-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--cimisy-radius-sm);
  padding: 7px 10px;
  font: inherit;
  font-size: 0.9em;
  color: var(--cimisy-text);
  cursor: pointer;
}
.cimisy-slash-menu-item.is-active {
  background: var(--cimisy-accent-soft);
  color: var(--cimisy-accent-text);
}
.cimisy-slash-menu-item-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: var(--cimisy-radius-sm);
  background: var(--cimisy-surface-2);
  color: var(--cimisy-text-soft);
  font-size: 0.72em;
  font-weight: 700;
}
.cimisy-slash-menu-item.is-active .cimisy-slash-menu-item-icon {
  background: var(--cimisy-accent-soft-2);
  color: var(--cimisy-accent-text);
}

.cimisy-editor-image-block {
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-md);
  padding: 10px;
  margin: 6px 0;
  background: var(--cimisy-surface-2);
}

.cimisy-editor-callout {
  border-radius: var(--cimisy-radius-md);
  padding: 10px 12px;
  margin: 6px 0;
}
.cimisy-editor-callout .cimisy-block-header {
  margin-bottom: 4px;
}
.cimisy-editor-callout-info {
  background: var(--cimisy-accent-soft);
}
.cimisy-editor-callout-warning {
  background: var(--cimisy-warning-soft);
}
.cimisy-editor-callout-danger {
  background: var(--cimisy-danger-soft);
}

.cimisy-block-outline-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--cimisy-border);
}
.cimisy-block-outline-item:last-child {
  border-bottom: none;
}

/* --- Live preview pane (M7) --- */

.cimisy-entry-layout {
  display: flex;
  gap: 28px;
  align-items: flex-start;
}
.cimisy-entry-main {
  flex: 1 1 420px;
  min-width: 0;
  padding-bottom: 68px;
}
.cimisy-entry-preview {
  flex: 1 1 380px;
  min-width: 0;
  position: sticky;
  top: 20px;
}
.cimisy-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.cimisy-preview-eyebrow {
  font-size: 0.72em;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--cimisy-text-soft);
}
.cimisy-preview-iframe {
  width: 100%;
  height: 75vh;
  min-height: 400px;
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-lg);
  background: var(--cimisy-surface);
}
/* Page group cards on the content-tree home screen. */
.cimisy-page-group {
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-lg);
  padding: 14px 16px;
  background: var(--cimisy-surface);
}
.cimisy-page-group-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 10px;
}
.cimisy-page-group-label {
  font-weight: 600;
}
.cimisy-page-group-children {
  margin-left: 12px;
}
.cimisy-page-group-section + .cimisy-page-group-section {
  margin-top: 12px;
}
.cimisy-page-group-section-label {
  display: block;
  font-size: 0.72em;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--cimisy-text-faint);
  margin-bottom: 6px;
}
/* Collapsed SEO panel (fields.seo). */
.cimisy-seo-panel {
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-lg);
  padding: 12px 14px;
  background: var(--cimisy-surface);
}
.cimisy-seo-toggle {
  display: flex;
  width: 100%;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font: inherit;
  color: var(--cimisy-text);
  text-align: left;
}
.cimisy-seo-body {
  margin-top: 14px;
  border-top: 1px solid var(--cimisy-border);
  padding-top: 14px;
}

/* --- Sticky bottom action bar (branch chip / PR status / submit) --- */

.cimisy-action-bar {
  position: sticky;
  bottom: 0;
  /* Low, explicit z-index: sticky elements can composite above higher-z-index absolutely
     positioned siblings (e.g. the slash menu dropdown, z-index 1000) once actually pinned —
     giving this one a small fixed value keeps it below any real overlay instead of relying
     on paint order. */
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 24px;
  padding: 12px 16px;
  background: var(--cimisy-surface);
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-lg);
  box-shadow: var(--cimisy-shadow-md);
}
.cimisy-action-bar-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

/* Below this width a side-by-side split leaves neither column usable — stack instead. */
@media (max-width: 860px) {
  .cimisy-entry-layout {
    flex-direction: column;
  }
  .cimisy-entry-preview {
    position: static;
    width: 100%;
  }
  .cimisy-preview-iframe {
    height: 60vh;
  }
  .cimisy-action-bar {
    flex-direction: column;
    align-items: stretch;
  }
}
`;
