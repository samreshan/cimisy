import "server-only";
import type { Octokit } from "@octokit/rest";
import { GithubAppAuth, type GithubAppCredentials } from "../../github/app-auth.js";
import { CimisyError } from "../../shared/errors.js";
import { assertSafeRepoPath } from "../../shared/slug.js";
import type {
  ChangeRequest,
  ChangeRequestSummary,
  ChangeResult,
  FileMeta,
  FileRecord,
  HistoryEntry,
  OpenChangeRequestInput,
  RawFileRecord,
  StorageAdapter,
} from "../../storage/types.js";

export interface GithubSourceOptions extends GithubAppCredentials {
  /** "owner/repo" */
  repo: string;
  /** Default branch writes land on when no other ref is specified. Defaults to "main". */
  branch?: string;
  /** Signs/verifies the session cookie — see next/session.ts. */
  sessionSecret: string;
}

function parseRepo(repo: string): { owner: string; name: string } {
  const match = /^(?<owner>[\w.-]+)\/(?<name>[\w.-]+)$/.exec(repo);
  if (!match?.groups) {
    throw new CimisyError(`githubSource repo must look like "owner/repo", got "${repo}".`, "INVALID_REPO");
  }
  return { owner: match.groups.owner!, name: match.groups.name! };
}

/** Content API responses are base64 with embedded newlines; decode to the original utf-8 text. */
function decodeBase64Content(content: string): string {
  return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
}

export class GithubStorageAdapter implements StorageAdapter {
  readonly kind = "github" as const;
  readonly capabilities = { branching: true, pullRequests: true, history: true };

  private readonly appAuth: GithubAppAuth;
  private readonly owner: string;
  private readonly repoName: string;
  readonly defaultBranch: string;
  readonly sessionSecret: string;
  readonly credentials: GithubAppCredentials;

  constructor(options: GithubSourceOptions) {
    if (!options.sessionSecret || options.sessionSecret.length < 32) {
      throw new CimisyError(
        "sessionSecret must be at least 32 characters — it signs the session cookie, and a short secret is brute-forceable. " +
          "Generate one with e.g. `openssl rand -base64 32`.",
        "WEAK_SESSION_SECRET",
      );
    }
    const { owner, name } = parseRepo(options.repo);
    this.owner = owner;
    this.repoName = name;
    this.defaultBranch = options.branch ?? "main";
    this.sessionSecret = options.sessionSecret;
    this.credentials = options;
    this.appAuth = new GithubAppAuth(options);
  }

  private getClient(): Promise<Octokit> {
    return this.appAuth.getInstallationClient(this.owner, this.repoName);
  }

  /** Exposed for RBAC (M3) to check a logged-in user's repo permission level via the App installation, without ever holding the user's own token. */
  async getCollaboratorPermission(username: string): Promise<string | null> {
    const octokit = await this.getClient();
    try {
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner: this.owner,
        repo: this.repoName,
        username,
      });
      return data.permission;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async read(path: string, ref?: string): Promise<FileRecord | null> {
    assertSafeRepoPath(path);
    const octokit = await this.getClient();
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repoName,
        path,
        ref: ref ?? this.defaultBranch,
      });
      if (Array.isArray(data) || data.type !== "file" || data.content === undefined) return null;
      return { path, content: decodeBase64Content(data.content), version: data.sha };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Raw-bytes read path for binary content (media, M4) — never utf-8-decodes, unlike read() above. */
  async readRaw(path: string, ref?: string): Promise<RawFileRecord | null> {
    assertSafeRepoPath(path);
    const octokit = await this.getClient();
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repoName,
        path,
        ref: ref ?? this.defaultBranch,
      });
      if (Array.isArray(data) || data.type !== "file" || data.content === undefined) return null;
      return { content: Buffer.from(data.content.replace(/\n/g, ""), "base64") };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async list(dirPrefix: string, ref?: string): Promise<FileMeta[]> {
    assertSafeRepoPath(dirPrefix);
    const octokit = await this.getClient();
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: this.owner,
        repo: this.repoName,
        path: dirPrefix,
        ref: ref ?? this.defaultBranch,
      });
      if (!Array.isArray(data)) return [];
      return data.filter((entry) => entry.type === "file").map((entry) => ({ path: entry.path, version: entry.sha }));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  async commitChange(change: ChangeRequest): Promise<ChangeResult> {
    for (const write of change.writes) assertSafeRepoPath(write.path);
    for (const path of change.deletes ?? []) assertSafeRepoPath(path);

    const octokit = await this.getClient();
    const ref = change.ref || this.defaultBranch;

    // Per-file optimistic-concurrency check — same semantics as the local
    // adapter, so callers see identical conflict behavior regardless of
    // which adapter is configured.
    const touchedPaths = [...change.writes.map((w) => w.path), ...(change.deletes ?? [])];
    for (const path of touchedPaths) {
      const current = await this.read(path, ref);
      const currentVersion = current?.version ?? null;
      if (currentVersion !== change.baseVersion) {
        return { version: currentVersion ?? "", conflict: { path, expected: change.baseVersion, actual: currentVersion ?? "" } };
      }
    }

    const { data: refData } = await octokit.rest.git.getRef({ owner: this.owner, repo: this.repoName, ref: `heads/${ref}` });
    const baseCommitSha = refData.object.sha;
    const { data: baseCommit } = await octokit.rest.git.getCommit({ owner: this.owner, repo: this.repoName, commit_sha: baseCommitSha });
    const baseTreeSha = baseCommit.tree.sha;

    const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string | null }> = [];
    let lastBlobSha = "";
    for (const write of change.writes) {
      const { data: blob } = await octokit.rest.git.createBlob({
        owner: this.owner,
        repo: this.repoName,
        content: write.content,
        encoding: write.encoding ?? "utf-8",
      });
      lastBlobSha = blob.sha;
      treeEntries.push({ path: write.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (const path of change.deletes ?? []) {
      treeEntries.push({ path, mode: "100644", type: "blob", sha: null });
    }

    const { data: newTree } = await octokit.rest.git.createTree({
      owner: this.owner,
      repo: this.repoName,
      base_tree: baseTreeSha,
      tree: treeEntries,
    });

    const { data: newCommit } = await octokit.rest.git.createCommit({
      owner: this.owner,
      repo: this.repoName,
      message: change.message,
      tree: newTree.sha,
      parents: [baseCommitSha],
      author: { name: change.author.name, email: change.author.email },
    });

    try {
      // force: false is deliberate — this is a fast-forward-only update, a
      // second concurrency guard beneath the per-file check above in case
      // something else landed a commit in the narrow window between them.
      await octokit.rest.git.updateRef({
        owner: this.owner,
        repo: this.repoName,
        ref: `heads/${ref}`,
        sha: newCommit.sha,
        force: false,
      });
    } catch (err) {
      if (isUnprocessable(err) || isConflictStatus(err)) {
        const conflictPath = touchedPaths[0] ?? "";
        const actual = conflictPath ? await this.read(conflictPath, ref) : null;
        return {
          version: actual?.version ?? "",
          conflict: { path: conflictPath, expected: change.baseVersion, actual: actual?.version ?? "" },
        };
      }
      throw err;
    }

    return { version: lastBlobSha || newCommit.sha };
  }

  /** Idempotent: a draft branch that already exists (a continuing draft) is left as-is rather than treated as an error. */
  async createBranch(name: string, fromRef: string): Promise<void> {
    const octokit = await this.getClient();
    const { data } = await octokit.rest.git.getRef({ owner: this.owner, repo: this.repoName, ref: `heads/${fromRef}` });
    try {
      await octokit.rest.git.createRef({
        owner: this.owner,
        repo: this.repoName,
        ref: `refs/heads/${name}`,
        sha: data.object.sha,
      });
    } catch (err) {
      if (isUnprocessable(err)) return; // "Reference already exists"
      throw err;
    }
  }

  /** Idempotent: if a PR for this branch is already open, returns it instead of erroring on a duplicate-PR attempt. */
  async openChangeRequest(input: OpenChangeRequestInput): Promise<{ id: string; url: string }> {
    const octokit = await this.getClient();
    try {
      const { data } = await octokit.rest.pulls.create({
        owner: this.owner,
        repo: this.repoName,
        head: input.sourceRef,
        base: input.targetRef,
        title: input.title,
        body: input.body,
      });
      return { id: String(data.number), url: data.html_url };
    } catch (err) {
      if (!isUnprocessable(err)) throw err;
      const { data: existing } = await octokit.rest.pulls.list({
        owner: this.owner,
        repo: this.repoName,
        head: `${this.owner}:${input.sourceRef}`,
        base: input.targetRef,
        state: "open",
      });
      const pr = existing[0];
      if (!pr) throw err; // 422 for some other reason — surface the original error
      return { id: String(pr.number), url: pr.html_url };
    }
  }

  async mergeChangeRequest(id: string): Promise<void> {
    const octokit = await this.getClient();
    await octokit.rest.pulls.merge({ owner: this.owner, repo: this.repoName, pull_number: Number(id) });
  }

  /**
   * Lists open PRs whose head branch starts with `headPrefix` (the drafts,
   * M5, discovery path). GitHub's `head` list filter only supports an
   * exact "owner:branch" match, not a prefix, so this fetches all open PRs
   * and filters client-side — acceptable for the "open PRs on a single
   * cimisy-managed repo" scale this is built for.
   */
  async listChangeRequests(filter: { headPrefix: string }): Promise<ChangeRequestSummary[]> {
    const octokit = await this.getClient();
    const { data } = await octokit.rest.pulls.list({ owner: this.owner, repo: this.repoName, state: "open" });
    return data
      .filter((pr) => pr.head.ref.startsWith(filter.headPrefix))
      .map((pr) => ({
        id: String(pr.number),
        title: pr.title,
        sourceRef: pr.head.ref,
        url: pr.html_url,
        state: pr.state as "open" | "closed",
        updatedAt: pr.updated_at,
        author: pr.user?.login,
      }));
  }

  async getHistory(path: string): Promise<HistoryEntry[]> {
    assertSafeRepoPath(path);
    const octokit = await this.getClient();
    const { data } = await octokit.rest.repos.listCommits({
      owner: this.owner,
      repo: this.repoName,
      path,
      sha: this.defaultBranch,
    });
    return data.map((commit) => ({
      version: commit.sha,
      message: commit.commit.message,
      author: {
        id: commit.author?.id ? String(commit.author.id) : "",
        name: commit.commit.author?.name ?? "",
        email: commit.commit.author?.email ?? "",
      },
      date: commit.commit.author?.date ?? "",
    }));
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 404;
}

function isUnprocessable(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 422;
}

function isConflictStatus(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status: unknown }).status === 409;
}

export function githubSource(options: GithubSourceOptions): GithubStorageAdapter {
  return new GithubStorageAdapter(options);
}
