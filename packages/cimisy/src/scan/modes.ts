/**
 * The four scan depths `cimisy scan` supports, from cheapest to broadest.
 * Two orthogonal switches underneath: whether static (non-repeating)
 * content is analyzed, and whether page metadata is. Plain collections
 * scanning always runs — it's the reason the command exists.
 *
 * The pre-2.3 `--full` flag maps to "static-metadata" (it ran both).
 */
export const SCAN_MODES = ["collections", "collections-metadata", "static", "static-metadata"] as const;

export type ScanMode = (typeof SCAN_MODES)[number];

export const DEFAULT_SCAN_MODE: ScanMode = "collections";

export function isScanMode(value: string): value is ScanMode {
  return (SCAN_MODES as readonly string[]).includes(value);
}

export function resolveScanMode(mode: ScanMode): { includeStatic: boolean; includeMetadata: boolean } {
  return {
    includeStatic: mode === "static" || mode === "static-metadata",
    includeMetadata: mode === "collections-metadata" || mode === "static-metadata",
  };
}
