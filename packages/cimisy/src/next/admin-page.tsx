import type { CimisyConfig } from "../config/define-config.js";
import { AdminApp } from "../react/admin-app.js";
import { buildAdminManifest } from "./manifest.js";

export interface CimisyAdminPageProps {
  cimisyConfig: CimisyConfig;
  segments: string[];
  /** URL path the admin UI is mounted at, e.g. "/admin". */
  basePath: string;
  /** URL path the API route handler is mounted at, e.g. "/api/cimisy". */
  apiBasePath: string;
}

export function CimisyAdminPage({ cimisyConfig, segments, basePath, apiBasePath }: CimisyAdminPageProps) {
  const manifest = buildAdminManifest(cimisyConfig);
  return <AdminApp manifest={manifest} segments={segments} basePath={basePath} apiBasePath={apiBasePath} />;
}
