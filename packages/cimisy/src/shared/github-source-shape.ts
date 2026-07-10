import type { StorageAdapter } from "../storage/types.js";

/**
 * A structural (not class-based) view of just the pieces of
 * GithubStorageAdapter that the generic Next integration and RBAC engine
 * need. Deliberately avoids importing the concrete adapter class:
 * cimisy/next is used by local-adapter-only consumers too, and importing
 * the GitHub adapter module here would pull its dependencies (octokit,
 * jose) into every consumer's bundle regardless of which source they
 * actually use — defeating the subpath-export isolation the package
 * layout is built around (see packages/cimisy/package.json's "exports"
 * map). Lives under shared/ (not next/ or rbac/) since both of those need
 * it and neither should depend on the other. Extends StorageAdapter
 * (rather than just the RBAC-specific pieces) because rbac/user-store.ts
 * needs both together — reading/writing the user roster through the same
 * adapter that resolves collaborator permission.
 */
export interface GithubIntegratedSource extends StorageAdapter {
  kind: "github";
  sessionSecret: string;
  credentials: { clientId: string; clientSecret: string };
  getCollaboratorPermission(username: string): Promise<string | null>;
}

export function isGithubSource(source: { kind: string }): source is GithubIntegratedSource {
  return source.kind === "github";
}
