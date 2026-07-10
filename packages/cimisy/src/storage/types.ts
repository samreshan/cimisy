export interface FileRecord {
  path: string;
  content: string;
  /** Opaque version token (git blob/commit SHA today; a row version/etag for a future DB adapter). */
  version: string;
}

export interface FileMeta {
  path: string;
  version: string;
}

export interface ChangeAuthor {
  name: string;
  email: string;
  /** Stable identity id from the auth layer (e.g. GitHub user id) — used for audit trails. */
  id: string;
}

export interface ChangeRequest {
  /** Branch/ref being written against. */
  ref: string;
  /**
   * Optimistic-concurrency check: the version the writer last read. If `ref`
   * has moved past this in the meantime, the adapter must reject the write
   * with a `conflict` result rather than silently overwriting it.
   */
  baseVersion: string | null;
  message: string;
  author: ChangeAuthor;
  /**
   * All writes/deletes in a ChangeRequest land as ONE atomic unit (a single
   * git commit is atomic across files; a DB adapter would wrap this in a
   * transaction). Never split a logical change into multiple ChangeRequests.
   *
   * `encoding` defaults to `"utf-8"` when omitted (source/YAML content, the
   * only kind v1 ever wrote). Media (M4) writes base64-encoded binary
   * content and must set `encoding: "base64"` — `content` is then the raw
   * base64 string, not utf-8 text.
   */
  writes: Array<{ path: string; content: string; encoding?: "utf-8" | "base64" }>;
  deletes?: string[];
}

export interface ChangeResult {
  version: string;
  /** Present when `baseVersion` was stale — caller should reload and retry, never auto-merge. */
  conflict?: { path: string; expected: string | null; actual: string };
}

export interface HistoryEntry {
  version: string;
  message: string;
  author: ChangeAuthor;
  date: string;
}

export interface OpenChangeRequestInput {
  sourceRef: string;
  targetRef: string;
  title: string;
  body?: string;
}

export interface RawFileRecord {
  /** Raw decoded bytes — never utf-8-decoded, since this is the path for binary content (media). */
  content: Uint8Array;
  /** Best-effort MIME type if the adapter can determine one cheaply; callers should not depend on it being present. */
  contentType?: string;
}

export interface ChangeRequestSummary {
  /** Adapter-specific identifier (e.g. GitHub PR number) — pass back to mergeChangeRequest. */
  id: string;
  title: string;
  /** The branch/ref the change request is proposing to merge (the "head"). */
  sourceRef: string;
  url: string;
  state: "open" | "closed";
  updatedAt: string;
  /** Best-effort author login/name, when the adapter can report one cheaply. */
  author?: string;
}

export interface StorageAdapter {
  readonly kind: "local" | "github" | (string & {});
  readonly capabilities: {
    branching: boolean;
    pullRequests: boolean;
    history: boolean;
  };

  read(path: string, ref?: string): Promise<FileRecord | null>;
  list(dirPrefix: string, ref?: string): Promise<FileMeta[]>;
  commitChange(change: ChangeRequest): Promise<ChangeResult>;

  // Optional capabilities gated by `capabilities` above — a DB adapter can
  // omit these entirely rather than no-op them, since they don't map to a
  // 1:1 DB concept the same way branch/PR does for git.
  createBranch?(name: string, fromRef: string): Promise<void>;
  openChangeRequest?(input: OpenChangeRequestInput): Promise<{ id: string; url: string }>;
  mergeChangeRequest?(id: string): Promise<void>;
  getHistory?(path: string): Promise<HistoryEntry[]>;
  /** Reads a file's raw bytes without any text decoding — the media (M4) read path. Omit entirely on adapters that can't serve binary content cheaply. */
  readRaw?(path: string, ref?: string): Promise<RawFileRecord | null>;
  /** Lists open change requests (e.g. GitHub PRs) whose source ref starts with `headPrefix` — the drafts (M5) discovery path. Gated by `capabilities.pullRequests`; omit on adapters without a PR concept (e.g. local). */
  listChangeRequests?(filter: { headPrefix: string }): Promise<ChangeRequestSummary[]>;
}
