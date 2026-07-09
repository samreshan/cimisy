import { CimisyError } from "../shared/errors.js";
import type { StorageAdapter } from "../storage/types.js";

export interface DraftInfo {
  branch: string;
  pullRequestUrl: string;
}

/**
 * Ensures a draft branch (and its PR) exist for a non-direct-publish
 * write, then returns where to point the actual content commit. Both
 * createBranch and openChangeRequest are idempotent on the GitHub adapter
 * (see adapters/github/adapter.ts), so calling this on every save for the
 * same entry is cheap — it just reuses the existing branch/PR after the
 * first call. Adapter-agnostic by design: only touches the generic
 * StorageAdapter capability surface, not GitHub specifics, so a future
 * adapter with branching+PR support works here unchanged.
 */
export async function ensureDraftBranchAndPr(
  source: StorageAdapter,
  branch: string,
  defaultBranch: string,
  title: string,
): Promise<DraftInfo> {
  if (!source.capabilities.branching || !source.createBranch || !source.capabilities.pullRequests || !source.openChangeRequest) {
    throw new CimisyError(
      "This storage adapter doesn't support draft branches/pull requests, but the resolved role requires PR-gated publishing.",
      "DRAFT_UNSUPPORTED",
    );
  }
  await source.createBranch(branch, defaultBranch);
  const pr = await source.openChangeRequest({
    sourceRef: branch,
    targetRef: defaultBranch,
    title,
  });
  return { branch, pullRequestUrl: pr.url };
}
