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
 * it and neither should depend on the other.
 */
export interface GithubIntegratedSource {
  kind: "github";
  sessionSecret: string;
  credentials: { clientId: string; clientSecret: string };
  getCollaboratorPermission(username: string): Promise<string | null>;
}

export function isGithubSource(source: { kind: string }): source is GithubIntegratedSource {
  return source.kind === "github";
}
