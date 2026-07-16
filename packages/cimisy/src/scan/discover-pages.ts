import { readdir } from "node:fs/promises";
import path from "node:path";

export interface DiscoverPagesOptions {
  /** Absolute path to the Next.js App Router root (the directory containing page.tsx files), e.g. "<project>/src/app" or "<project>/app". */
  appDir: string;
  /** appDir-relative path prefixes to skip entirely (from cimisy.config's `scan.exclude`), e.g. ["admin", "(marketing)/legal"]. */
  exclude?: string[];
}

/**
 * Every App Router special file the scanner treats as a root to analyze
 * from. `page` renders one route; the rest render *around* routes:
 * layout/template wrap every page in their subtree, loading/error render
 * in a page's place, not-found/global-error can render for any route.
 * `route.ts` handlers (no JSX) and `default.*` parallel-route fallbacks
 * are deliberately not entrypoints.
 */
export type EntrypointKind = "page" | "layout" | "template" | "not-found" | "loading" | "error" | "global-error";

export interface Entrypoint {
  filePath: string;
  kind: EntrypointKind;
}

const SKIP_DIR_NAMES = new Set(["node_modules", ".next", ".git"]);

const ENTRYPOINT_BASE_NAMES: EntrypointKind[] = [
  "page",
  "layout",
  "template",
  "not-found",
  "loading",
  "error",
  "global-error",
];

/** The extensions Next.js's App Router recognizes by default (configurable via next.config's `pageExtensions`, but these four cover the default). */
const ENTRYPOINT_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

const ENTRYPOINT_KIND_BY_FILE_NAME = new Map<string, EntrypointKind>(
  ENTRYPOINT_BASE_NAMES.flatMap((base) => ENTRYPOINT_EXTENSIONS.map((ext): [string, EntrypointKind] => [`${base}${ext}`, base])),
);

/**
 * Recursively finds every App Router entrypoint file under `appDir` —
 * pages plus the layout/template/special files listed above, including
 * inside `@slot` parallel-route directories. Intercepting-route
 * directories (`(.)x`, `(..)x`, `(...)x`) are skipped: their route
 * semantics don't fit route derivation and they re-render content that's
 * already reachable at its canonical route. Pages Router (`pages/`) is
 * out of scope — see the scan/apply plan.
 */
export async function discoverEntrypoints(options: DiscoverPagesOptions): Promise<Entrypoint[]> {
  const entrypoints: Entrypoint[] = [];
  const excludePrefixes = (options.exclude ?? []).map((prefix) => prefix.replace(/\/+$/, ""));
  await walk(options.appDir, options.appDir, excludePrefixes, entrypoints);
  return entrypoints.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

/** Back-compat wrapper: just the page files, as plain paths — what the pre-2.3 scanner consumed. */
export async function discoverPages(options: DiscoverPagesOptions): Promise<string[]> {
  const entrypoints = await discoverEntrypoints(options);
  return entrypoints.filter((e) => e.kind === "page").map((e) => e.filePath);
}

function isExcluded(relPath: string, excludePrefixes: string[]): boolean {
  return excludePrefixes.some((prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`));
}

async function walk(dir: string, appDir: string, excludePrefixes: string[], out: Entrypoint[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(appDir, fullPath).split(path.sep).join("/");
    if (isExcluded(relPath, excludePrefixes)) continue;
    if (entry.isDirectory()) {
      // "(."-prefixed dirs are intercepting routes (see doc comment above);
      // "."-prefixed dirs are tooling (".vercel" etc.). "@slot" parallel-route
      // dirs match neither and are walked like any other segment.
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith("(.") || entry.name.startsWith(".")) continue;
      await walk(fullPath, appDir, excludePrefixes, out);
    } else if (entry.isFile()) {
      const kind = ENTRYPOINT_KIND_BY_FILE_NAME.get(entry.name);
      if (kind) out.push({ filePath: fullPath, kind });
    }
  }
}
