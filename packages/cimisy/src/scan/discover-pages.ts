import { readdir } from "node:fs/promises";
import path from "node:path";

export interface DiscoverPagesOptions {
  /** Absolute path to the Next.js App Router root (the directory containing page.tsx files), e.g. "<project>/src/app" or "<project>/app". */
  appDir: string;
}

const SKIP_DIR_NAMES = new Set(["node_modules", ".next", ".git"]);

/**
 * Recursively finds every App Router `page.tsx` under `appDir`. Pages
 * Router (`pages/`) is out of scope — see the scan/apply plan.
 */
export async function discoverPages(options: DiscoverPagesOptions): Promise<string[]> {
  const pages: string[] = [];
  await walk(options.appDir, pages);
  return pages.sort();
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name === "page.tsx") {
      out.push(path.join(dir, entry.name));
    }
  }
}
