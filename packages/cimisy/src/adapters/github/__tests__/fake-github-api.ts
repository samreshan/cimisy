import { createHash } from "node:crypto";

/**
 * A minimal in-memory stand-in for the slice of the GitHub REST + Git Data
 * API this adapter actually calls. Stubs `global.fetch` directly rather
 * than using an HTTP-mocking library: Octokit v21 (and our own oauth.ts)
 * use Node's native `fetch` by default, and nock's interception of native
 * fetch/undici is inconsistent across Node versions — stubbing the global
 * directly is the more reliable option and lets us assert on the actual
 * request sequence, not just "some request happened."
 */
export interface FakeGithubApi {
  owner: string;
  repo: string;
  installationId: number;
  requests: Array<{ method: string; url: string }>;
  setCollaboratorPermission(username: string, permission: string | null): void;
  /** Resolves the current file state of a branch (for test assertions), by walking its head commit's tree. */
  filesOnBranch(branch: string): Map<string, string>;
  /** Directly commits a file to the default branch, outside of any adapter call — for seeding fixture state (e.g. a pre-existing .cimisy/users.yaml) before a test exercises the real read/write path. */
  seedFile(path: string, content: string): void;
  install(): void;
  restore(): void;
}

function blobSha(content: string): string {
  return createHash("sha1").update(content).digest("hex");
}

export function createFakeGithubApi(options: {
  owner: string;
  repo: string;
  defaultBranch?: string;
  initialFiles?: Record<string, string>;
}): FakeGithubApi {
  const defaultBranch = options.defaultBranch ?? "main";
  const collaboratorPermissions = new Map<string, string>();
  const requests: Array<{ method: string; url: string }> = [];

  const branches = new Map<string, string>(); // branch name -> head commit sha
  const commits = new Map<
    string,
    { treeSha: string; parents: string[]; message: string; author: { name: string; email: string; date: string }; authorId: number }
  >();
  const trees = new Map<string, Array<{ path: string; sha: string | null }>>();
  const blobStore = new Map<string, string>();
  const pullRequests: Array<{ number: number; head: string; base: string; state: "open" | "closed"; title: string; url: string }> = [];

  const initialEntries: Array<{ path: string; sha: string }> = [];
  for (const [path, content] of Object.entries(options.initialFiles ?? {})) {
    const sha = blobSha(content);
    blobStore.set(sha, content);
    initialEntries.push({ path, sha });
  }
  commits.set("commit-0", {
    treeSha: "tree-0",
    parents: [],
    message: "initial commit",
    author: { name: "Fake", email: "fake@example.com", date: new Date(0).toISOString() },
    authorId: 0,
  });
  trees.set("tree-0", initialEntries);
  branches.set(defaultBranch, "commit-0");
  let commitCounter = 1;
  let treeCounter = 1;
  let prCounter = 1;

  const installationId = 999;
  let originalFetch: typeof fetch;

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  function notFound(): Response {
    return json({ message: "Not Found" }, 404);
  }

  /** Flattens a tree by resolving `base_tree` + applying this tree's entries (null sha = delete) on top. */
  function resolveTree(treeSha: string): Map<string, string> {
    const entries = trees.get(treeSha) ?? [];
    const result = new Map<string, string>();
    for (const entry of entries) {
      if (entry.sha === null) continue;
      result.set(entry.path, entry.sha);
    }
    return result;
  }

  function filesOnBranch(branch: string): Map<string, string> {
    const headSha = branches.get(branch);
    if (!headSha) return new Map();
    const commit = commits.get(headSha);
    if (!commit) return new Map();
    const resolved = resolveTree(commit.treeSha);
    const result = new Map<string, string>();
    for (const [filePath, sha] of resolved) {
      const content = blobStore.get(sha);
      if (content !== undefined) result.set(filePath, content);
    }
    return result;
  }

  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, url });
    const u = new URL(url);
    // Octokit's route templates use simple URI-template expansion for
    // `{ref}` (not reserved `{+ref}`), so a multi-segment ref like
    // "heads/main" arrives here as "heads%2Fmain" — GitHub's real API is
    // known to decode this correctly server-side (this is the standard,
    // widely-used way Octokit callers pass refs), so the fake mirrors that
    // by decoding the whole path once up front rather than treating %2F as
    // a literal path segment.
    const path = decodeURIComponent(u.pathname);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    // --- GitHub App auth (via @octokit/auth-app) ---
    if (method === "GET" && path === `/repos/${options.owner}/${options.repo}/installation`) {
      return json({ id: installationId });
    }
    if (method === "POST" && path === `/app/installations/${installationId}/access_tokens`) {
      return json({ token: "fake-installation-token", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }

    // --- Collaborator permission ---
    const collabMatch = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/.exec(path);
    if (method === "GET" && collabMatch) {
      const username = collabMatch[1]!;
      const permission = collaboratorPermissions.get(username);
      if (!permission) return notFound();
      return json({ permission });
    }

    // --- Contents API (read/list) ---
    const contentsMatch = /^\/repos\/[^/]+\/[^/]+\/contents\/(.*)$/.exec(path);
    if (method === "GET" && contentsMatch) {
      const requestedPath = contentsMatch[1] ?? "";
      const ref = u.searchParams.get("ref") ?? defaultBranch;
      const files = filesOnBranch(ref);
      if (files.has(requestedPath)) {
        const content = files.get(requestedPath)!;
        return json({
          type: "file",
          path: requestedPath,
          content: Buffer.from(content, "utf8").toString("base64"),
          sha: blobSha(content),
        });
      }
      const prefix = requestedPath.length > 0 ? `${requestedPath}/` : "";
      const dirEntries = [...files.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => ({ type: "file" as const, path: p, sha: blobSha(files.get(p)!) }));
      if (dirEntries.length === 0) return notFound();
      return json(dirEntries);
    }

    // --- Git Data API ---
    const refMatch = /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/(.+)$/.exec(path);
    if (method === "GET" && refMatch) {
      const branch = refMatch[1]!;
      const sha = branches.get(branch);
      if (!sha) return notFound();
      return json({ ref: `refs/heads/${branch}`, object: { sha } });
    }

    const createRefMatch = /^\/repos\/[^/]+\/[^/]+\/git\/refs$/.exec(path);
    if (method === "POST" && createRefMatch) {
      const refName = String(body.ref).replace(/^refs\/heads\//, "");
      if (branches.has(refName)) {
        return json({ message: "Reference already exists" }, 422);
      }
      branches.set(refName, body.sha as string);
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }

    const commitMatch = /^\/repos\/[^/]+\/[^/]+\/git\/commits\/(.+)$/.exec(path);
    if (method === "GET" && commitMatch) {
      const commit = commits.get(commitMatch[1]!);
      if (!commit) return notFound();
      return json({ sha: commitMatch[1], tree: { sha: commit.treeSha }, parents: commit.parents.map((p) => ({ sha: p })) });
    }

    if (method === "POST" && path === `/repos/${options.owner}/${options.repo}/git/blobs`) {
      const content = body.content as string;
      const sha = blobSha(content);
      blobStore.set(sha, content);
      return json({ sha }, 201);
    }

    if (method === "POST" && path === `/repos/${options.owner}/${options.repo}/git/trees`) {
      const baseTree = body.base_tree as string | undefined;
      const baseEntries = baseTree ? (trees.get(baseTree) ?? []) : [];
      const newEntries = body.tree as Array<{ path: string; sha: string | null }>;
      const merged = [...baseEntries.filter((e) => !newEntries.some((n) => n.path === e.path)), ...newEntries];
      const sha = `tree-${treeCounter++}`;
      trees.set(sha, merged);
      return json({ sha }, 201);
    }

    if (method === "POST" && path === `/repos/${options.owner}/${options.repo}/git/commits`) {
      const sha = `commit-${commitCounter++}`;
      const author = body.author as { name?: string; email?: string } | undefined;
      commits.set(sha, {
        treeSha: body.tree as string,
        parents: (body.parents as string[]) ?? [],
        message: String(body.message ?? ""),
        author: { name: author?.name ?? "", email: author?.email ?? "", date: new Date().toISOString() },
        authorId: 1,
      });
      return json({ sha }, 201);
    }

    // GET /repos/{owner}/{repo}/commits — REST "list commits" (distinct
    // from the Git Data API's GET /git/commits/{sha} above). Walks the
    // branch's parent chain; doesn't filter by the `path` query param
    // (our fake has no per-commit changed-files index) — adequate for
    // exercising the adapter's request/response handling, not a full
    // GitHub API reimplementation.
    if (method === "GET" && path === `/repos/${options.owner}/${options.repo}/commits`) {
      const shaParam = u.searchParams.get("sha") ?? defaultBranch;
      const history: Array<{ sha: string; commit: unknown; author: { id: number } }> = [];
      let cursor = branches.get(shaParam) ?? shaParam;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const commit = commits.get(cursor);
        if (!commit) break;
        history.push({
          sha: cursor,
          commit: { message: commit.message, author: commit.author },
          author: { id: commit.authorId },
        });
        cursor = commit.parents[0] ?? "";
      }
      return json(history);
    }

    const updateRefMatch = /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/(.+)$/.exec(path);
    if (method === "PATCH" && updateRefMatch) {
      const branch = updateRefMatch[1]!;
      const newSha = body.sha as string;
      const force = body.force as boolean | undefined;
      const newCommit = commits.get(newSha);
      const currentHead = branches.get(branch);
      if (!newCommit || currentHead === undefined) return json({ message: "not found" }, 422);
      const isFastForward = newCommit.parents.includes(currentHead);
      if (!isFastForward && !force) {
        return json({ message: "Update is not a fast forward" }, 422);
      }
      branches.set(branch, newSha);
      return json({ ref: `refs/heads/${branch}`, object: { sha: newSha } });
    }

    // --- Pull requests ---
    if (method === "POST" && path === `/repos/${options.owner}/${options.repo}/pulls`) {
      const head = body.head as string;
      const base = body.base as string;
      const duplicate = pullRequests.find((pr) => pr.head === head && pr.base === base && pr.state === "open");
      if (duplicate) {
        return json({ message: `A pull request already exists for ${options.owner}:${head}.` }, 422);
      }
      const number = prCounter++;
      const prUrl = `https://github.com/${options.owner}/${options.repo}/pull/${number}`;
      pullRequests.push({ number, head, base, state: "open", title: String(body.title ?? ""), url: prUrl });
      return json({ number, html_url: prUrl }, 201);
    }

    if (method === "GET" && path === `/repos/${options.owner}/${options.repo}/pulls`) {
      const headParam = u.searchParams.get("head"); // "owner:branch"
      const baseParam = u.searchParams.get("base");
      const stateParam = u.searchParams.get("state") ?? "open";
      const headBranch = headParam?.includes(":") ? headParam.split(":")[1] : headParam;
      const matches = pullRequests.filter(
        (pr) =>
          (!headBranch || pr.head === headBranch) &&
          (!baseParam || pr.base === baseParam) &&
          (stateParam === "all" || pr.state === stateParam),
      );
      return json(matches.map((pr) => ({ number: pr.number, html_url: pr.url, title: pr.title })));
    }

    const mergeMatch = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/merge$/.exec(path);
    if (method === "PUT" && mergeMatch) {
      const number = Number(mergeMatch[1]);
      const pr = pullRequests.find((p) => p.number === number);
      if (!pr) return notFound();
      pr.state = "closed";
      return json({ merged: true });
    }

    return json({ message: `fake-github-api: unhandled ${method} ${path}` }, 501);
  }

  return {
    owner: options.owner,
    repo: options.repo,
    installationId,
    requests,
    filesOnBranch,
    setCollaboratorPermission(username, permission) {
      if (permission === null) collaboratorPermissions.delete(username);
      else collaboratorPermissions.set(username, permission);
    },
    seedFile(path, content) {
      const sha = blobSha(content);
      blobStore.set(sha, content);
      const headSha = branches.get(defaultBranch)!;
      const headCommit = commits.get(headSha)!;
      const baseEntries = trees.get(headCommit.treeSha) ?? [];
      const newTreeSha = `tree-${treeCounter++}`;
      trees.set(newTreeSha, [...baseEntries.filter((e) => e.path !== path), { path, sha }]);
      const newCommitSha = `commit-${commitCounter++}`;
      commits.set(newCommitSha, {
        treeSha: newTreeSha,
        parents: [headSha],
        message: `seed ${path}`,
        author: { name: "test", email: "test@example.com", date: new Date().toISOString() },
        authorId: 0,
      });
      branches.set(defaultBranch, newCommitSha);
    },
    install() {
      originalFetch = global.fetch;
      global.fetch = handle as typeof fetch;
    },
    restore() {
      global.fetch = originalFetch;
    },
  };
}
