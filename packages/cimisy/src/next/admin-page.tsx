import type { ResolvedCimisyConfig } from "../config/define-config.js";
import { AdminApp } from "../react/admin-app.js";
import { isUnconfiguredSource } from "../storage/unconfigured.js";
import { buildAdminManifest } from "./manifest.js";
import { CimisyUnconfiguredPage } from "./unconfigured-page.js";

export interface CimisyAdminPageProps {
  cimisyConfig: ResolvedCimisyConfig;
  segments: string[];
  /** URL path the admin UI is mounted at, e.g. "/admin". */
  basePath: string;
  /** URL path the API route handler is mounted at, e.g. "/api/cimisy". */
  apiBasePath: string;
}

export function CimisyAdminPage({ cimisyConfig, segments, basePath, apiBasePath }: CimisyAdminPageProps) {
  // A deployment whose GitHub variables never arrived (see
  // storage/unconfigured.ts). There's no source to authenticate against
  // and nothing to edit, so this renders static instructions instead of an
  // admin UI that could only fail — see unconfigured-page.tsx for why that
  // page holds no inputs.
  if (isUnconfiguredSource(cimisyConfig.source)) {
    return <CimisyUnconfiguredPage missing={cimisyConfig.source.missing} basePath={basePath} />;
  }

  const manifest = buildAdminManifest(cimisyConfig);
  return <AdminApp manifest={manifest} segments={segments} basePath={basePath} apiBasePath={apiBasePath} />;
}
