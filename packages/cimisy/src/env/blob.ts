import { CimisyError } from "../shared/errors.js";

/**
 * `CIMISY_CONFIG` — the one-paste alternative to the seven individual
 * `CIMISY_*` env vars. Setting a GitHub-backed deployment up used to mean
 * transcribing seven values into a hosting dashboard, one of them a
 * multi-line PEM that dashboards routinely mangle; this packs all of them
 * into a single opaque, newline-free, shell-safe string that `cimisy setup
 * github` prints and the deployer pastes once.
 *
 * base64url, NOT encryption — the blob is a transport encoding, and its
 * contents are exactly as secret as the vars it replaces. Never log it,
 * never put it in an error message. Version-stamped so a future field
 * change can be recognized rather than silently misread by an older
 * cimisy.
 *
 * Deliberately dependency-free (no `server-only`, no adapters): the CLI
 * writes blobs from plain Node and the runtime reads them inside Next.
 */

export const CIMISY_CONFIG_BLOB_VERSION = 1;

export interface CimisyConfigBlobV1 {
  v: 1;
  /** "owner/repo" */
  repo: string;
  /** Optional — the runtime defaults to "main" when absent. */
  branch?: string;
  appId: string;
  /** PEM, real newlines or `\n`-escaped — both survive the JSON round trip. */
  privateKey: string;
  clientId: string;
  clientSecret: string;
  sessionSecret: string;
}

export type CimisyConfigBlobInput = Omit<CimisyConfigBlobV1, "v">;

const REQUIRED_FIELDS = ["repo", "appId", "privateKey", "clientId", "clientSecret", "sessionSecret"] as const;

/** base64url's alphabet — anything else means the value was truncated, re-wrapped, or shell-mangled in transit. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeCimisyConfigBlob(config: CimisyConfigBlobInput): string {
  const payload: CimisyConfigBlobV1 = {
    v: CIMISY_CONFIG_BLOB_VERSION,
    repo: config.repo,
    ...(config.branch ? { branch: config.branch } : {}),
    appId: config.appId,
    privateKey: config.privateKey,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    sessionSecret: config.sessionSecret,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Every failure path here is deliberately content-free: the blob holds a
 * private key and two secrets, so an error message that echoed it (or any
 * slice of it) would leak credentials into logs, CI output, and pasted
 * bug reports. Callers get the *shape* of the problem and nothing else.
 */
export function decodeCimisyConfigBlob(blob: string): CimisyConfigBlobV1 {
  const trimmed = blob.trim();
  if (!trimmed || !BASE64URL_PATTERN.test(trimmed)) {
    throw new CimisyError(
      "CIMISY_CONFIG is not valid base64url — it was probably truncated or line-wrapped when it was pasted. " +
        'Re-run "npx cimisy setup github" to print a fresh one, and paste it as a single line.',
      "INVALID_CONFIG_BLOB",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8"));
  } catch {
    throw new CimisyError(
      "CIMISY_CONFIG decoded to something that isn't valid JSON — it was probably corrupted in transit. " +
        'Re-run "npx cimisy setup github" to print a fresh one.',
      "INVALID_CONFIG_BLOB",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CimisyError("CIMISY_CONFIG did not decode to a config object.", "INVALID_CONFIG_BLOB");
  }
  const record = parsed as Record<string, unknown>;

  if (record.v === undefined) {
    throw new CimisyError(
      "CIMISY_CONFIG carries no format version — it wasn't produced by cimisy. " +
        'Run "npx cimisy setup github" to generate one.',
      "INVALID_CONFIG_BLOB",
    );
  }
  if (record.v !== CIMISY_CONFIG_BLOB_VERSION) {
    throw new CimisyError(
      `CIMISY_CONFIG declares format version ${JSON.stringify(record.v)}, but this version of cimisy only understands version ${CIMISY_CONFIG_BLOB_VERSION}. ` +
        "Upgrade cimisy, or re-run \"npx cimisy setup github\" with this version to print a compatible blob.",
      "UNSUPPORTED_CONFIG_BLOB_VERSION",
    );
  }

  const missing = REQUIRED_FIELDS.filter((field) => typeof record[field] !== "string" || record[field] === "");
  if (missing.length > 0) {
    throw new CimisyError(
      `CIMISY_CONFIG is missing required field${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. ` +
        'Re-run "npx cimisy setup github" to print a complete one.',
      "INVALID_CONFIG_BLOB",
    );
  }
  if (record.branch !== undefined && typeof record.branch !== "string") {
    throw new CimisyError('CIMISY_CONFIG\'s "branch" field must be a string.', "INVALID_CONFIG_BLOB");
  }

  // Rebuilt field-by-field rather than spread: an older blob (or a
  // tampered one) carrying extra keys must not smuggle them into the
  // options object handed to githubSource.
  return {
    v: CIMISY_CONFIG_BLOB_VERSION,
    repo: record.repo as string,
    ...(record.branch ? { branch: record.branch as string } : {}),
    appId: record.appId as string,
    privateKey: record.privateKey as string,
    clientId: record.clientId as string,
    clientSecret: record.clientSecret as string,
    sessionSecret: record.sessionSecret as string,
  };
}
