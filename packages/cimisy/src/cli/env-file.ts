/**
 * Additive, idempotent `.env.local` editing for `cimisy setup github`.
 *
 * The wizard writes into a file it does not own: a real project's
 * `.env.local` holds database URLs, API keys, and analytics tokens that
 * have nothing to do with cimisy, and silently dropping one of those would
 * be a far worse outcome than any setup step failing. So this rewrites
 * only the exact lines whose keys are being set and leaves every other
 * byte — comments, blank lines, ordering, `export` prefixes, unrelated
 * keys — exactly where it found it.
 *
 * Values are always written as a single double-quoted line with real
 * newlines escaped to `\n`. That matters for the App private key: a
 * multi-line PEM pasted raw into a `.env` file is the single most common
 * way GitHub setups break, and `\n`-escaped is the form both dotenv (which
 * Next.js uses) and cimisy's own `normalizePrivateKey` understand.
 */

export interface EnvFileMergeResult {
  content: string;
  /** Keys that weren't in the file before. */
  added: string[];
  /** Keys that were present with a different value. */
  updated: string[];
  /** Keys already present with exactly this value — a re-run writes nothing for these. */
  unchanged: string[];
}

/** Matches an assignment line, capturing an optional `export ` prefix and the key. */
const ASSIGNMENT_PATTERN = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * Formats a value for a `.env` file. Always quoted, so a value containing
 * spaces, `#`, or newlines can never be mis-parsed.
 *
 * Note dotenv (what Next.js loads `.env.local` with) only un-escapes
 * `\n`/`\r` inside double quotes, not `\\`. That's fine here: none of
 * cimisy's values — base64url, hex, repo slugs, URLs, PEM bodies — contain
 * a literal backslash, and escaping it anyway keeps the round trip through
 * parseEnvValue below exact.
 */
export function formatEnvValue(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r\n|\r|\n/g, "\\n");
  return `"${escaped}"`;
}

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

/**
 * Inverse of formatEnvValue, plus the unquoted and single-quoted forms a
 * hand-written file may use. Matches dotenv's semantics: a quoted value
 * ends at its closing quote (anything after it, typically a `# comment`,
 * is not part of the value), and an unquoted value ends at an inline `#`.
 */
export function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const closing = findClosingQuote(trimmed, quote);
    if (closing !== -1) {
      const body = trimmed.slice(1, closing);
      // One pass, not chained replaces: `\\n` must decode to a backslash
      // followed by "n", never to a backslash followed by a real newline.
      return quote === '"' ? body.replace(/\\([nrt"\\])/g, (_match, escape: string) => DOUBLE_QUOTE_ESCAPES[escape]!) : body;
    }
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

/**
 * Index of the closing quote. -1 when the value never closes on this
 * string. Backslash escapes are honored inside double quotes only —
 * dotenv treats a single-quoted value as fully literal.
 */
function findClosingQuote(value: string, quote: string): number {
  const honorsEscapes = quote === '"';
  for (let i = 1; i < value.length; i++) {
    if (honorsEscapes && value[i] === "\\") {
      i++;
      continue;
    }
    if (value[i] === quote) return i;
  }
  return -1;
}

/**
 * Reads a `.env` file's keys. Only used to answer narrow questions ("is a
 * session secret already set?"), never to rewrite the file — rewriting
 * goes through mergeEnvFile, which works on lines rather than on a parsed
 * map precisely so nothing can be lost in a round trip.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(#|$)/.test(line)) continue;
    const match = ASSIGNMENT_PATTERN.exec(line);
    if (!match) continue;
    const [, , , key, rawValue] = match;
    const span = readValueSpan(lines, i, rawValue!);
    result[key!] = parseEnvValue(span.raw);
    i = span.endIndex;
  }
  return result;
}

/**
 * A value can span multiple physical lines when it opens a quote that
 * doesn't close on the same line — which is exactly how a hand-pasted
 * multi-line PEM looks. Returning the full span means replacing such a key
 * removes all of its lines rather than leaving orphaned PEM body lines
 * behind as syntax garbage.
 */
function readValueSpan(lines: string[], startIndex: number, rawValue: string): { raw: string; endIndex: number } {
  const quote = /^\s*("|')/.exec(rawValue)?.[1];
  if (!quote) return { raw: rawValue, endIndex: startIndex };
  if (findClosingQuote(rawValue.trimStart(), quote) !== -1) return { raw: rawValue, endIndex: startIndex };

  let raw = rawValue;
  for (let i = startIndex + 1; i < lines.length; i++) {
    raw += `\n${lines[i]!}`;
    if (lines[i]!.includes(quote)) return { raw, endIndex: i };
  }
  // Unterminated quote — treat it as ending at the last line rather than
  // silently swallowing the rest of the file into one key.
  return { raw, endIndex: lines.length - 1 };
}

export function mergeEnvFile(existing: string, updates: Record<string, string>): EnvFileMergeResult {
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const pending = new Set(Object.keys(updates));

  const lines = existing.split("\n");
  const output: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = ASSIGNMENT_PATTERN.exec(line);
    const key = match?.[3];

    if (!match || !key || !pending.has(key)) {
      output.push(line);
      continue;
    }

    const start = i;
    const span = readValueSpan(lines, start, match[4]!);
    i = span.endIndex;
    pending.delete(key);

    const nextValue = updates[key]!;
    if (parseEnvValue(span.raw) === nextValue) {
      unchanged.push(key);
      // Byte-for-byte preservation: an already-correct value is left in
      // whatever form the user wrote it, so a re-run produces no diff.
      output.push(...lines.slice(start, span.endIndex + 1));
      continue;
    }

    updated.push(key);
    output.push(`${match[1]!}${match[2] ?? ""}${key}=${formatEnvValue(nextValue)}`);
  }

  const appended: string[] = [];
  for (const key of Object.keys(updates)) {
    if (!pending.has(key)) continue;
    added.push(key);
    appended.push(`${key}=${formatEnvValue(updates[key]!)}`);
  }

  let content = output.join("\n");
  if (appended.length > 0) {
    if (content !== "" && !content.endsWith("\n")) content += "\n";
    content += `${appended.join("\n")}\n`;
  } else if (content !== "" && !content.endsWith("\n")) {
    content += "\n";
  }

  return { content, added, updated, unchanged };
}

/**
 * Whether a `.gitignore` already covers `.env.local`. Deliberately
 * conservative — it recognizes the handful of patterns Next.js and friends
 * actually ship (`.env*.local`, `.env.local`, `.env*`) rather than
 * implementing gitignore glob semantics, and a false "not ignored" only
 * costs a warning the user can dismiss, while a false "ignored" would
 * quietly let a private key reach a public repo.
 */
export function gitignoreCoversEnvLocal(gitignore: string): boolean {
  return gitignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .some((line) => [".env.local", ".env*.local", ".env*", ".env**", "*.local"].includes(line.replace(/^\/+/, "")));
}
