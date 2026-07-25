/**
 * PEM keys are multi-line, and env files/dashboards routinely mangle real
 * newlines — the common workaround is storing the key with literal `\n`
 * escape sequences instead. Only rewrite those to real newlines when the
 * string has no actual newline already, so a correctly-stored multi-line
 * key (e.g. from a `.env` file that preserves it, or a secrets manager) is
 * never touched.
 *
 * Lives in shared/ (not github/app-auth.ts, where it started) because the
 * env-driven resolver and the CLI both need it, and neither can import a
 * `server-only` module.
 */
export function normalizePrivateKey(privateKey: string): string {
  if (privateKey.includes("\n")) return privateKey;
  return privateKey.replace(/\\n/g, "\n");
}

/** Cheap structural check — "does this look like a PEM block at all", not "is this a valid key". Used by `cimisy doctor` to tell a mangled paste apart from a wrong-but-well-formed key. */
export function looksLikePem(privateKey: string): boolean {
  const normalized = normalizePrivateKey(privateKey);
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(normalized) && /-----END [A-Z ]*PRIVATE KEY-----/.test(normalized);
}
