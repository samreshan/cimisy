import type { FieldDefinition } from "./fields/types.js";

export interface SingletonOptions<Schema extends Record<string, FieldDefinition>> {
  /** e.g. "content/settings/site.yaml" — a single fixed file, not a glob. */
  path: string;
  schema: Schema;
}

export interface SingletonDefinition<Schema extends Record<string, FieldDefinition> = Record<string, FieldDefinition>> {
  readonly type: "singleton";
  readonly path: string;
  readonly schema: Schema;
}

export function singleton<Schema extends Record<string, FieldDefinition>>(
  options: SingletonOptions<Schema>,
): SingletonDefinition<Schema> {
  if (options.path.includes("*") || options.path.includes("..")) {
    throw new Error(`Singleton path "${options.path}" must be a fixed path (no "*" or "..").`);
  }
  return {
    type: "singleton",
    path: options.path,
    schema: options.schema,
  };
}
