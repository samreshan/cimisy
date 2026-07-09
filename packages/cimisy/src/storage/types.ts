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
   */
  writes: Array<{ path: string; content: string }>;
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
}
