// Re-export shim: the admin UI implementation lives in ./admin/* (split out
// of a single 800+ line file for the editor-experience work — see
// ./admin/app.tsx for the entry point). This file is kept only so
// next/admin-page.tsx's import path doesn't need to change.
export { AdminApp } from "./admin/app.js";
export type { AdminAppProps } from "./admin/app.js";
