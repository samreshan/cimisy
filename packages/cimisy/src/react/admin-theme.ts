/**
 * A single injected stylesheet rather than a CSS file import: cimisy ships
 * as a plain 1:1-transpiled package (see tsup.config.ts's bundle: false),
 * so it can't rely on the consumer's bundler resolving `import "./x.css"`
 * from node_modules — that's fragile across Next.js versions/bundlers.
 * Rendering one <style> tag from AdminApp works everywhere with zero
 * config. Everything is scoped under .cimisy-root so it can't leak into
 * (or be leaked into by) the consumer's own site styles.
 */
export const ADMIN_THEME_CSS = `
.cimisy-root {
  --cimisy-bone: #f8f3ea;
  --cimisy-bone-soft: #efe6d4;
  --cimisy-charcoal: #2b2723;
  --cimisy-charcoal-soft: #726a5d;
  --cimisy-border: #ddd0b7;
  --cimisy-purple: #6d42c7;
  --cimisy-purple-dark: #55339e;
  --cimisy-purple-soft: #efe7fb;
  --cimisy-success: #3f7a5c;
  --cimisy-success-soft: #e3f0e9;
  --cimisy-warning: #a86a1d;
  --cimisy-warning-soft: #f7ecd8;
  --cimisy-danger: #b3432f;
  --cimisy-danger-soft: #f8e5df;
  --cimisy-radius-sm: 6px;
  --cimisy-radius-md: 9px;
  --cimisy-radius-lg: 13px;

  color: var(--cimisy-charcoal);
  background: var(--cimisy-bone);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  max-width: 960px;
  margin: 0 auto;
  padding: 40px 24px 80px;
  box-sizing: border-box;
}
.cimisy-root *,
.cimisy-root *::before,
.cimisy-root *::after {
  box-sizing: inherit;
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
  font-weight: 700;
  font-size: 1.05em;
  color: var(--cimisy-charcoal);
  text-decoration: none;
  letter-spacing: -0.01em;
}
.cimisy-nav-links {
  display: flex;
  gap: 4px;
  flex: 1;
}
.cimisy-nav-link {
  color: var(--cimisy-charcoal-soft);
  text-decoration: none;
  font-weight: 600;
  font-size: 0.9em;
  padding: 6px 10px;
  border-radius: var(--cimisy-radius-sm);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.cimisy-nav-link:hover {
  background: var(--cimisy-bone-soft);
  color: var(--cimisy-charcoal);
}
.cimisy-nav-user {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.85em;
  color: var(--cimisy-charcoal-soft);
}

.cimisy-badge {
  display: inline-block;
  background: var(--cimisy-purple-soft);
  color: var(--cimisy-purple-dark);
  font-weight: 650;
  font-size: 0.78em;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 3px 8px;
  border-radius: 999px;
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

.cimisy-heading {
  font-size: 1.7em;
  font-weight: 650;
  letter-spacing: -0.01em;
  margin: 0 0 22px;
  color: var(--cimisy-charcoal);
}

.cimisy-subheading {
  font-size: 1.05em;
  font-weight: 650;
  margin: 0 0 10px;
  color: var(--cimisy-charcoal);
}

.cimisy-muted {
  color: var(--cimisy-charcoal-soft);
}

.cimisy-link {
  color: var(--cimisy-purple);
  text-decoration: none;
  font-weight: 550;
}
.cimisy-link:hover {
  color: var(--cimisy-purple-dark);
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
  background: #fffdf8;
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-lg);
  padding: 14px 16px;
  box-shadow: 0 1px 2px rgba(43, 39, 35, 0.05);
  color: var(--cimisy-charcoal);
  text-decoration: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
a.cimisy-card:hover {
  border-color: var(--cimisy-purple);
  box-shadow: 0 2px 8px rgba(109, 66, 199, 0.12);
  transform: translateY(-1px);
}
.cimisy-card-error {
  border-color: var(--cimisy-danger);
  background: var(--cimisy-danger-soft);
  color: var(--cimisy-danger);
}

.cimisy-empty {
  color: var(--cimisy-charcoal-soft);
  background: var(--cimisy-bone-soft);
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
  transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.05s ease;
}
.cimisy-btn:active {
  transform: translateY(1px);
}
.cimisy-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.cimisy-btn-primary {
  background: var(--cimisy-purple);
  border-color: var(--cimisy-purple);
  color: var(--cimisy-bone);
}
.cimisy-btn-primary:hover:not(:disabled) {
  background: var(--cimisy-purple-dark);
  border-color: var(--cimisy-purple-dark);
}
.cimisy-btn-secondary {
  background: #fffdf8;
  border-color: var(--cimisy-border);
  color: var(--cimisy-charcoal);
}
.cimisy-btn-secondary:hover:not(:disabled) {
  border-color: var(--cimisy-purple);
  color: var(--cimisy-purple);
}
.cimisy-btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--cimisy-charcoal-soft);
  padding: 6px 9px;
  font-size: 0.85em;
}
.cimisy-btn-ghost:hover:not(:disabled) {
  background: var(--cimisy-bone-soft);
  color: var(--cimisy-charcoal);
}

.cimisy-field {
  margin-bottom: 18px;
}
.cimisy-label {
  display: block;
  font-size: 0.85em;
  font-weight: 600;
  color: var(--cimisy-charcoal-soft);
  margin-bottom: 6px;
}
.cimisy-input,
.cimisy-textarea,
.cimisy-select {
  width: 100%;
  font: inherit;
  font-size: 0.95em;
  color: var(--cimisy-charcoal);
  background: #fffdf8;
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-md);
  padding: 9px 12px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.cimisy-textarea {
  resize: vertical;
}
.cimisy-input:focus,
.cimisy-textarea:focus,
.cimisy-select:focus {
  outline: none;
  border-color: var(--cimisy-purple);
  box-shadow: 0 0 0 3px var(--cimisy-purple-soft);
}
.cimisy-input[type="text"].cimisy-input-mono,
.cimisy-textarea-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
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
  background: var(--cimisy-bone-soft);
  margin-top: 6px;
}
.cimisy-block {
  background: #fffdf8;
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
  color: var(--cimisy-charcoal-soft);
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
  color: var(--cimisy-charcoal-soft);
  padding: 8px 0;
  border-bottom: 1px solid var(--cimisy-border);
}
.cimisy-history-item:last-child {
  border-bottom: none;
}
.cimisy-history-item code {
  background: var(--cimisy-bone-soft);
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
  background: #fffdf8;
  padding: 12px 16px;
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
  margin: 0.6em 0 0.4em;
  font-weight: 650;
  color: var(--cimisy-charcoal);
}
.cimisy-editor-shell .ProseMirror pre {
  background: var(--cimisy-bone-soft);
  border-radius: var(--cimisy-radius-md);
  padding: 12px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.88em;
}
.cimisy-editor-shell .ProseMirror code {
  background: var(--cimisy-bone-soft);
  border-radius: var(--cimisy-radius-sm);
  padding: 1px 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.92em;
}
.cimisy-editor-shell .ProseMirror pre code {
  background: none;
  padding: 0;
}
.cimisy-editor-shell .ProseMirror a {
  color: var(--cimisy-purple);
}
.cimisy-editor-shell .ProseMirror p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  color: var(--cimisy-charcoal-soft);
  float: left;
  height: 0;
  pointer-events: none;
}

.cimisy-bubble-menu {
  display: flex;
  gap: 2px;
  background: var(--cimisy-charcoal);
  border-radius: var(--cimisy-radius-md);
  padding: 4px;
  box-shadow: 0 4px 14px rgba(43, 39, 35, 0.25);
}
.cimisy-bubble-btn {
  background: transparent;
  border: none;
  color: var(--cimisy-bone);
  border-radius: var(--cimisy-radius-sm);
  padding: 5px 9px;
  font: inherit;
  font-size: 0.85em;
  cursor: pointer;
}
.cimisy-bubble-btn:hover {
  background: rgba(248, 243, 234, 0.15);
}
.cimisy-bubble-btn.is-active {
  background: var(--cimisy-purple);
}

.cimisy-slash-menu {
  background: #fffdf8;
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-md);
  box-shadow: 0 4px 14px rgba(43, 39, 35, 0.15);
  padding: 4px;
  min-width: 180px;
  max-height: 260px;
  overflow-y: auto;
}
.cimisy-slash-menu-empty {
  padding: 8px 10px;
  color: var(--cimisy-charcoal-soft);
  font-size: 0.85em;
}
.cimisy-slash-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: var(--cimisy-radius-sm);
  padding: 7px 10px;
  font: inherit;
  font-size: 0.9em;
  color: var(--cimisy-charcoal);
  cursor: pointer;
}
.cimisy-slash-menu-item.is-active {
  background: var(--cimisy-purple-soft);
  color: var(--cimisy-purple-dark);
}

.cimisy-editor-image-block {
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-md);
  padding: 10px;
  margin: 6px 0;
  background: var(--cimisy-bone-soft);
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
  background: var(--cimisy-purple-soft);
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
.cimisy-preview-iframe {
  width: 100%;
  height: 75vh;
  min-height: 400px;
  border: 1px solid var(--cimisy-border);
  border-radius: var(--cimisy-radius-lg);
  background: #fff;
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
}
`;
