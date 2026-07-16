import type { NormalizedSingleton } from "../config/define-config.js";
import type { ChangeAuthor, ChangeResult, StorageAdapter } from "../storage/types.js";
import { parseSingleton, serializeSingleton } from "./singleton-codec.js";
import { validateFieldValues } from "./validate-values.js";

export interface SingletonSnapshot {
  version: string;
  values: Record<string, unknown>;
}

/**
 * Returns null when the file doesn't exist yet — a singleton always
 * exists conceptually (it's declared in config), so "missing" is the
 * not-yet-created state the admin renders as an empty form, not an error.
 * Unlike collection listings there's no per-file error isolation to do:
 * one singleton is one file, so a parse failure just propagates.
 */
export async function readSingleton(
  adapter: StorageAdapter,
  def: NormalizedSingleton,
  ref?: string,
): Promise<SingletonSnapshot | null> {
  const record = await adapter.read(def.path, ref);
  if (!record) return null;
  return { version: record.version, values: parseSingleton(def, record.content) };
}

export interface WriteSingletonInput {
  values: Record<string, unknown>;
  baseVersion: string | null;
  author: ChangeAuthor;
  message: string;
  ref: string;
}

/**
 * The write path never derives anything from user input: def.path is a
 * fixed, config()-validated location. No delete counterpart on purpose —
 * a declared singleton has nowhere sensible to "go away" to.
 */
export async function writeSingleton(
  adapter: StorageAdapter,
  def: NormalizedSingleton,
  input: WriteSingletonInput,
): Promise<ChangeResult> {
  const content = serializeSingleton(def, validateFieldValues(def.schema, input.values));
  return adapter.commitChange({
    ref: input.ref,
    baseVersion: input.baseVersion,
    message: input.message,
    author: input.author,
    writes: [{ path: def.path, content }],
  });
}
