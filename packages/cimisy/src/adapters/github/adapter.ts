import "server-only";
import type { Octokit } from "@octokit/rest";
import { GithubAppAuth, type GithubAppCredentials } from "../../github/app-auth.js";
import { CimisyError } from "../../shared/errors.js";
import { CIMISY_ENV_VARS, GITHUB_CREDENTIAL_ENV_VARS, missingGithubCredentialsMessage, type GithubCredentialKey } from "../../shared/github-env.js";
import { parseRepoSpec } from "../../shared/repo-spec.js";
import { assertSafeRepoPath } from "../../shared/slug.js";
import {
  expectedBaseVersion,
  type ChangeRequest,
  type ChangeRequestSummary,
  type ChangeResult,
  type FileMeta,
  type FileRecord,
  type HistoryEntry,
  type OpenChangeRequestInput,
  type RawFileRecord,
  type StorageAdapter,
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
  const parsed = parseRepoSpec(repo);
  if (!parsed) {
    throw new CimisyError(`githubSource repo must look like "owner/repo", got "${repo}".`, "INVALID_REPO");
  }
  return parsed;
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
    // Fail at config load with the exact missing name(s) — without this, an
    // unset env var sails through as `undefined` and only surfaces much
    // later as an opaque 500 from the GitHub client mid-request.
    if (!options.repo) {
      throw new CimisyError(
        `githubSource is missing "repo" — usually wired from the ${CIMISY_ENV_VARS.repo} env var (e.g. in .env.local). Expected "owner/repo".`,
        "MISSING_GITHUB_CONFIG",
      );
    }
    const missing = (Object.keys(GITHUB_CREDENTIAL_ENV_VARS) as GithubCredentialKey[]).filter((key) => !options[key]);
    if (missing.length > 0) {
      throw new CimisyError(missingGithubCredentialsMessage(missing), "MISSING_GITHUB_CONFIG");
    }
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
      const base64 = await this.resolveContentBase64(octokit, path, data);
      return { path, content: decodeBase64Content(base64), version: data.sha };
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
      const base64 = await this.resolveContentBase64(octokit, path, data);
      return { content: Buffer.from(base64.replace(/\n/g, ""), "base64") };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * The Contents API silently returns `content: ""` (with `encoding:
   * "none"`) for blobs over 1 MB — NOT an error. Before this guard, a
   * >1 MB YAML singleton parsed as an empty document, rendered as an
   * all-defaults form, and the next save overwrote the real file with
   * defaults. Fall back to the Blobs API (good to 100 MB) and fail closed
   * — an empty body for a non-empty blob is never treated as content.
   */
  private async resolveContentBase64(
    octokit: Octokit,
    path: string,
    data: { content: string; sha: string; size: number },
  ): Promise<string> {
    if (data.content !== "" || data.size === 0) return data.content;
    const { data: blob } = await octokit.rest.git.getBlob({
      owner: this.owner,
      repo: this.repoName,
      file_sha: data.sha,
    });
    if (blob.content === "") {
      throw new CimisyError(
        `GitHub returned no content for "${path}" (${data.size} bytes, blob ${data.sha}) — refusing to treat a non-empty file as empty.`,
        "GITHUB_CONTENT_UNAVAILABLE",
      );
    }
    return blob.content;
  }

  /**
   * Uses the Git Trees API rather than the Contents API: Contents caps a
   * directory listing at 1,000 files WITHOUT pagination or an error, so a
   * collection's 1,001st entry silently didn't exist. A tree fetch has no
   * such cap (its limits are 100k entries / 7 MB per subtree). The
   * `{ref}:{path}` expression resolves the subtree in one request; blob
   * SHAs are identical to the Contents API's `sha`, so version tokens are
   * unchanged.
   */
  async list(dirPrefix: string, ref?: string): Promise<FileMeta[]> {
    assertSafeRepoPath(dirPrefix);
    const octokit = await this.getClient();
    try {
      const { data } = await octokit.rest.git.getTree({
        owner: this.owner,
        repo: this.repoName,
        tree_sha: `${ref ?? this.defaultBranch}:${dirPrefix}`,
      });
      const files: FileMeta[] = [];
      for (const entry of data.tree) {
        if (entry.type !== "blob" || typeof entry.path !== "string" || typeof entry.sha !== "string") continue;
        files.push({ path: `${dirPrefix}/${entry.path}`, version: entry.sha });
      }
      return files;
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
    // which adapter is configured. Resolved from ONE tree listing per
    // touched directory rather than one Contents read per file: a listing
    // yields every touched path's current blob SHA at once, and a path
    // absent from its directory's listing is "file doesn't exist"
    // (current version null) — exactly what read() would have reported.
    const touchedPaths = [...change.writes.map((w) => w.path), ...(change.deletes ?? [])];
    const currentVersions = new Map<string, string>();
    for (const dir of new Set(touchedPaths.map(parentDirectory))) {
      if (dir === null) continue; // repo-root file: no directory to list, checked below
      for (const meta of await this.list(dir, ref)) currentVersions.set(meta.path, meta.version);
    }
    for (const path of touchedPaths) {
      // Repo-root paths (no parent directory) fall back to a direct read.
      const currentVersion =
        parentDirectory(path) === null
          ? ((await this.read(path, ref))?.version ?? null)
          : (currentVersions.get(path) ?? null);
      const expected = expectedBaseVersion(change.baseVersion, path);
      if (currentVersion !== expected) {
        return { version: currentVersion ?? "", conflict: { path, expected, actual: currentVersion ?? "" } };
      }
    }

    const { data: refData } = await octokit.rest.git.getRef({ owner: this.owner, repo: this.repoName, ref: `heads/${ref}` });
    const baseCommitSha = refData.object.sha;
    const { data: baseCommit } = await octokit.rest.git.getCommit({ owner: this.owner, repo: this.repoName, commit_sha: baseCommitSha });
    const baseTreeSha = baseCommit.tree.sha;

    // Text content is inlined into createTree — GitHub writes the blob out
    // as part of tree creation, turning a K-file commit from 2K+5 requests
    // into a flat 5. That also matters for GitHub's content-creation rate
    // limit (80/min, 500/hr), which the old one-createBlob-per-file loop
    // burned K times faster. Only base64 (binary media) writes still need
    // an explicit blob: createTree's inline `content` is utf-8 only.
    const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha?: string | null; content?: string }> = [];
    for (const write of change.writes) {
      if ((write.encoding ?? "utf-8") === "base64") {
        const { data: blob } = await octokit.rest.git.createBlob({
          owner: this.owner,
          repo: this.repoName,
          content: write.content,
          encoding: "base64",
        });
        treeEntries.push({ path: write.path, mode: "100644", type: "blob", sha: blob.sha });
      } else {
        treeEntries.push({ path: write.path, mode: "100644", type: "blob", content: write.content });
      }
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

    // The version token for the last write comes from the created tree's
    // response entries (inline-content blobs never pass through
    // createBlob, so the response is the only place their SHA appears).
    const lastWritePath = change.writes.at(-1)?.path;
    const lastBlobSha = lastWritePath ? (newTree.tree.find((entry) => entry.path === lastWritePath)?.sha ?? "") : "";

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
          conflict: {
            path: conflictPath,
            expected: expectedBaseVersion(change.baseVersion, conflictPath),
            actual: actual?.version ?? "",
          },
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

/** "content/posts/hello.mdx" → "content/posts"; null for a repo-root path (nothing to list). */
function parentDirectory(path: string): string | null {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? null : path.slice(0, idx);
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
