import { execFileSync } from "node:child_process";

/**
 * The git checks both import surfaces (the `cimisy import` CLI and the
 * dev-only in-admin scan screen — see next/route-handler.ts's scan routes)
 * run before rewriting any source file. Extracted from cli/index.ts so the
 * two can never drift: same checks, same branch-name convention, same
 * failure messages.
 */

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function isGitRepo(cwd: string): boolean {
  try {
    git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

export function isWorkingTreeClean(cwd: string): boolean {
  return git(["status", "--porcelain"], cwd) === "";
}

export function createImportBranch(cwd: string): string {
  const branch = `cimisy/import-${Date.now()}`;
  git(["checkout", "-b", branch], cwd);
  return branch;
}

export const NOT_A_GIT_REPO_MESSAGE =
  "cimisy import must run inside a git repository — it creates a dedicated branch before writing anything.";

export const DIRTY_TREE_MESSAGE =
  "Working tree has uncommitted changes. Commit or stash them first, or re-run with --allow-dirty if you understand the risk.";
