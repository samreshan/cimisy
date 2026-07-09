import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { CimisyError, UnsafePathError } from "../shared/errors.js";
import type {
  ChangeRequest,
  ChangeResult,
  FileMeta,
  FileRecord,
  StorageAdapter,
} from "./types.js";

export interface LocalSourceOptions {
  /** Directory (relative to the consuming app's cwd, or absolute) that all content paths are resolved under. */
  rootDir: string;
  /**
   * The local adapter writes directly to disk with no auth check — it's a
   * dev-only convenience. Set true only if you understand the implications
   * (e.g. a controlled internal tool with its own access control in front).
   */
  allowInProduction?: boolean;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Resolves a repo-relative content path against rootDir and verifies the
 * result cannot escape rootDir. This is defense-in-depth: callers are
 * expected to have already built `path` from a validated slug (see
 * shared/slug.ts), but this adapter never trusts that on its own — the
 * same check runs here independent of the caller.
 */
function resolveSafe(rootDir: string, path: string): string {
  const resolvedRoot = resolve(rootDir);
  const resolvedPath = resolve(resolvedRoot, path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) {
    throw new UnsafePathError(`Path "${path}" resolves outside the content root.`);
  }
  return resolvedPath;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly kind = "local" as const;
  readonly capabilities = { branching: false, pullRequests: false, history: false };
  private readonly rootDir: string;

  constructor(options: LocalSourceOptions) {
    if (process.env.NODE_ENV === "production" && !options.allowInProduction) {
      throw new CimisyError(
        "LocalStorageAdapter refuses to run with NODE_ENV=production (no auth, direct disk writes). " +
          "Use the GitHub adapter in production, or pass allowInProduction: true if you have your own access control in front.",
        "LOCAL_ADAPTER_IN_PRODUCTION",
      );
    }
    this.rootDir = resolve(options.rootDir);
  }

  async read(path: string): Promise<FileRecord | null> {
    const absPath = resolveSafe(this.rootDir, path);
    try {
      const content = await readFile(absPath, "utf8");
      return { path, content, version: hashContent(content) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async list(dirPrefix: string): Promise<FileMeta[]> {
    const absDir = resolveSafe(this.rootDir, dirPrefix);
    let entries: string[];
    try {
      entries = await readdir(absDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const results: FileMeta[] = [];
    for (const entry of entries) {
      const entryAbsPath = join(absDir, entry);
      const entryStat = await stat(entryAbsPath);
      if (!entryStat.isFile()) continue;
      const content = await readFile(entryAbsPath, "utf8");
      results.push({ path: `${dirPrefix}/${entry}`, version: hashContent(content) });
    }
    return results;
  }

  async commitChange(change: ChangeRequest): Promise<ChangeResult> {
    // Optimistic concurrency: verify every file we're about to touch —
    // writes AND deletes alike — still matches the version the caller last
    // read (null baseVersion means the caller believes the file doesn't
    // exist yet), before touching anything on disk.
    const touchedPaths = [...change.writes.map((w) => w.path), ...(change.deletes ?? [])];
    for (const path of touchedPaths) {
      const current = await this.read(path);
      const currentVersion = current?.version ?? null;
      if (currentVersion !== change.baseVersion) {
        return {
          version: currentVersion ?? "",
          conflict: { path, expected: change.baseVersion, actual: currentVersion ?? "" },
        };
      }
    }

    for (const write of change.writes) {
      const absPath = resolveSafe(this.rootDir, write.path);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, write.content, "utf8");
    }
    for (const path of change.deletes ?? []) {
      const absPath = resolveSafe(this.rootDir, path);
      await rm(absPath, { force: true });
    }

    const lastWrite = change.writes.at(-1);
    return { version: lastWrite ? hashContent(lastWrite.content) : hashContent("") };
  }
}

export function localSource(options: LocalSourceOptions): StorageAdapter {
  return new LocalStorageAdapter(options);
}
