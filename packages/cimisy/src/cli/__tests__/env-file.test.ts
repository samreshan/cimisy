import { describe, expect, it } from "vitest";
import { formatEnvValue, gitignoreCoversEnvLocal, mergeEnvFile, parseEnvFile, parseEnvValue } from "../env-file.js";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef+/==\n-----END RSA PRIVATE KEY-----\n";

/** A realistic pre-existing .env.local — the file the wizard has to edit without breaking anything in it. */
const EXISTING = [
  "# Local development secrets — do not commit",
  "",
  "DATABASE_URL=postgres://localhost:5432/app",
  'STRIPE_KEY="sk_test_abc123"   # billing sandbox',
  "NEXT_PUBLIC_ANALYTICS_ID=UA-1234",
  "",
  "# cimisy",
  "CIMISY_GITHUB_REPO=old-org/old-repo",
  "",
].join("\n");

describe("formatEnvValue / parseEnvValue", () => {
  it("round-trips a multi-line PEM as a single escaped line", () => {
    const formatted = formatEnvValue(PEM);
    expect(formatted).not.toContain("\n");
    expect(formatted.startsWith('"') && formatted.endsWith('"')).toBe(true);
    expect(parseEnvValue(formatted)).toBe(PEM);
  });

  it("round-trips values containing quotes, spaces, and hashes", () => {
    for (const value of ['a "quoted" value', "has # hash", "  padded  ", "base64+/=", "back\\slash"]) {
      expect(parseEnvValue(formatEnvValue(value))).toBe(value);
    }
  });

  it("decodes an escaped backslash-n as a backslash and an n, not as a newline", () => {
    expect(parseEnvValue('"a\\\\nb"')).toBe("a\\nb");
  });

  it("reads the unquoted and single-quoted forms a hand-written file may use", () => {
    expect(parseEnvValue("plain")).toBe("plain");
    expect(parseEnvValue("plain # trailing comment")).toBe("plain");
    expect(parseEnvValue("'single quoted'")).toBe("single quoted");
  });
});

describe("parseEnvFile", () => {
  it("reads keys, skipping comments and blanks", () => {
    expect(parseEnvFile(EXISTING)).toEqual({
      DATABASE_URL: "postgres://localhost:5432/app",
      STRIPE_KEY: "sk_test_abc123",
      NEXT_PUBLIC_ANALYTICS_ID: "UA-1234",
      CIMISY_GITHUB_REPO: "old-org/old-repo",
    });
  });

  it("reads a hand-pasted multi-line quoted value as one key", () => {
    const content = ['KEY="line one', "line two", 'line three"', "AFTER=ok"].join("\n");
    expect(parseEnvFile(content)).toEqual({ KEY: "line one\nline two\nline three", AFTER: "ok" });
  });

  it("reads an `export`-prefixed assignment", () => {
    expect(parseEnvFile("export FOO=bar\n")).toEqual({ FOO: "bar" });
  });
});

describe("mergeEnvFile", () => {
  it("creates a fresh file from nothing", () => {
    const result = mergeEnvFile("", { CIMISY_SOURCE: "github", CIMISY_GITHUB_REPO: "acme/site" });
    expect(result.content).toBe('CIMISY_SOURCE="github"\nCIMISY_GITHUB_REPO="acme/site"\n');
    expect(result.added).toEqual(["CIMISY_SOURCE", "CIMISY_GITHUB_REPO"]);
    expect(result.updated).toEqual([]);
  });

  it("preserves unrelated keys, comments, blank lines, and ordering byte-for-byte", () => {
    const result = mergeEnvFile(EXISTING, { CIMISY_SOURCE: "github", CIMISY_GITHUB_REPO: "acme/site" });
    expect(result.content).toContain("# Local development secrets — do not commit");
    expect(result.content).toContain("DATABASE_URL=postgres://localhost:5432/app");
    expect(result.content).toContain('STRIPE_KEY="sk_test_abc123"   # billing sandbox');
    expect(result.content).toContain("NEXT_PUBLIC_ANALYTICS_ID=UA-1234");
    // The untouched lines keep their original order and spelling.
    const untouched = result.content.split("\n").filter((line) => !line.startsWith("CIMISY_"));
    expect(untouched).toEqual(EXISTING.split("\n").filter((line) => !line.startsWith("CIMISY_")));
  });

  it("replaces an existing cimisy key in place rather than appending a duplicate", () => {
    const result = mergeEnvFile(EXISTING, { CIMISY_GITHUB_REPO: "acme/site" });
    expect(result.updated).toEqual(["CIMISY_GITHUB_REPO"]);
    expect(result.added).toEqual([]);
    expect(result.content.match(/^CIMISY_GITHUB_REPO=/gm)).toHaveLength(1);
    expect(result.content).toContain('CIMISY_GITHUB_REPO="acme/site"');
    expect(result.content).not.toContain("old-org/old-repo");
    // Still sits under its own "# cimisy" comment, where it was.
    expect(result.content).toContain('# cimisy\nCIMISY_GITHUB_REPO="acme/site"');
  });

  it("is idempotent — a second run with the same values changes nothing", () => {
    const updates = { CIMISY_SOURCE: "github", CIMISY_GITHUB_REPO: "acme/site", CIMISY_GITHUB_APP_PRIVATE_KEY: PEM };
    const first = mergeEnvFile(EXISTING, updates);
    const second = mergeEnvFile(first.content, updates);
    expect(second.content).toBe(first.content);
    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.sort()).toEqual(Object.keys(updates).sort());
  });

  it("replaces every line of a previously multi-line value, leaving no orphaned PEM body", () => {
    const withRawPem = ['CIMISY_GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----', "OLDKEYBODY", '-----END RSA PRIVATE KEY-----"', "AFTER=ok"].join("\n");
    const result = mergeEnvFile(withRawPem, { CIMISY_GITHUB_APP_PRIVATE_KEY: PEM });
    expect(result.content).not.toContain("OLDKEYBODY");
    expect(result.content).toContain("AFTER=ok");
    expect(parseEnvFile(result.content).CIMISY_GITHUB_APP_PRIVATE_KEY).toBe(PEM);
  });

  it("keeps an `export` prefix when rewriting that key", () => {
    const result = mergeEnvFile("export CIMISY_GITHUB_REPO=old/old\n", { CIMISY_GITHUB_REPO: "acme/site" });
    expect(result.content).toBe('export CIMISY_GITHUB_REPO="acme/site"\n');
  });

  it("does not touch a key that merely shares a prefix with one being set", () => {
    const result = mergeEnvFile("CIMISY_GITHUB_REPOSITORY=keep-me\n", { CIMISY_GITHUB_REPO: "acme/site" });
    expect(result.content).toContain("CIMISY_GITHUB_REPOSITORY=keep-me");
    expect(result.added).toEqual(["CIMISY_GITHUB_REPO"]);
  });

  it("always leaves the file ending in a newline", () => {
    expect(mergeEnvFile("FOO=bar", { CIMISY_SOURCE: "github" }).content.endsWith("\n")).toBe(true);
    expect(mergeEnvFile("FOO=bar", {}).content.endsWith("\n")).toBe(true);
  });

  it("round-trips every written value through the parser", () => {
    const updates = { CIMISY_GITHUB_APP_PRIVATE_KEY: PEM, CIMISY_SESSION_SECRET: "aB3+/xyz==", CIMISY_GITHUB_REPO: "acme/site" };
    const parsed = parseEnvFile(mergeEnvFile(EXISTING, updates).content);
    for (const [key, value] of Object.entries(updates)) expect(parsed[key]).toBe(value);
  });
});

describe("gitignoreCoversEnvLocal", () => {
  it("recognizes the patterns real projects ship", () => {
    expect(gitignoreCoversEnvLocal(".env*.local\n")).toBe(true);
    expect(gitignoreCoversEnvLocal("node_modules\n\n# env\n.env.local\n")).toBe(true);
    expect(gitignoreCoversEnvLocal("/.env*.local\n")).toBe(true);
    expect(gitignoreCoversEnvLocal(".env*\n")).toBe(true);
  });

  it("fails closed on anything it doesn't recognize — a false 'ignored' would leak a private key", () => {
    expect(gitignoreCoversEnvLocal("")).toBe(false);
    expect(gitignoreCoversEnvLocal("node_modules\ndist\n")).toBe(false);
    expect(gitignoreCoversEnvLocal(".env\n")).toBe(false);
    expect(gitignoreCoversEnvLocal("# .env.local\n")).toBe(false);
  });
});
