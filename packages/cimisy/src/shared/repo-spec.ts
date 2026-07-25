/** The "owner/repo" shorthand cimisy accepts everywhere a repository is named. Shared so the adapter, the setup wizard, and doctor all agree on what's valid. */
export const REPO_SPEC_PATTERN = /^(?<owner>[\w.-]+)\/(?<name>[\w.-]+)$/;

/** Returns null (rather than throwing) so each caller can raise the error its own layer should report. */
export function parseRepoSpec(repo: string): { owner: string; name: string } | null {
  const match = REPO_SPEC_PATTERN.exec(repo.trim());
  if (!match?.groups) return null;
  return { owner: match.groups.owner!, name: match.groups.name! };
}
