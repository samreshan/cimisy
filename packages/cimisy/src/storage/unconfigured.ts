import { CimisyError } from "../shared/errors.js";
import type { ChangeRequest, ChangeResult, FileMeta, FileRecord, StorageAdapter } from "./types.js";

/**
 * A third source kind that exists so a half-configured production deploy
 * fails *legibly* instead of catastrophically.
 *
 * Before this, a deployment with `CIMISY_SOURCE=github` and one missing
 * variable threw at config *import* — which in Next.js means the build
 * fails, or every route 500s with a stack trace, including the public
 * site. The person who caused it is usually someone pasting env vars into
 * a hosting dashboard, and a stack trace tells them nothing about which
 * variable they missed.
 *
 * So `resolveSourceFromEnv({ onIncomplete: "placeholder" })` returns this
 * instead: the app builds, the API answers 503 with the missing names, and
 * `/admin` renders instructions. Every actual content operation still
 * throws a typed error — this is a placeholder, never a fallback that
 * silently serves something wrong.
 *
 * `onIncomplete: "throw"` remains the default, so nobody who wants
 * fail-fast loses it.
 */

/** Structural view, so consumers (next/, rbac/) can recognize an unconfigured source without importing the class. */
export interface UnconfiguredSource extends StorageAdapter {
  kind: "unconfigured";
  /** Canonical env var names that were absent. Names only — never values. */
  missing: readonly string[];
}

export interface UnconfiguredSourceOptions {
  missing: readonly string[];
}

export class UnconfiguredStorageAdapter implements UnconfiguredSource {
  readonly kind = "unconfigured" as const;
  readonly capabilities = { branching: false, pullRequests: false, history: false };
  readonly missing: readonly string[];

  constructor(options: UnconfiguredSourceOptions) {
    this.missing = [...options.missing];
  }

  private unavailable(operation: string): never {
    throw new CimisyError(
      `cimisy is not configured, so it cannot ${operation}. Missing: ${this.missing.join(", ")}. ` +
        'Run "npx cimisy setup github" locally, then set CIMISY_CONFIG on your deployment and redeploy.',
      "SOURCE_UNCONFIGURED",
    );
  }

  async read(_path: string): Promise<FileRecord | null> {
    this.unavailable("read content");
  }

  async list(_dirPrefix: string): Promise<FileMeta[]> {
    this.unavailable("list content");
  }

  async commitChange(_change: ChangeRequest): Promise<ChangeResult> {
    this.unavailable("write content");
  }
}

export function unconfiguredSource(options: UnconfiguredSourceOptions): UnconfiguredStorageAdapter {
  return new UnconfiguredStorageAdapter(options);
}

/** Structural (not `instanceof`), matching isGithubSource — a duplicated module instance must not defeat the check. */
export function isUnconfiguredSource(source: { kind: string }): source is UnconfiguredSource {
  return source.kind === "unconfigured";
}
