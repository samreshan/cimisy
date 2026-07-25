import { describe, expect, it } from "vitest";
import { CimisyError } from "../../shared/errors.js";
import { CIMISY_CONFIG_BLOB_VERSION, decodeCimisyConfigBlob, encodeCimisyConfigBlob, type CimisyConfigBlobInput } from "../blob.js";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc+/def==\n-----END RSA PRIVATE KEY-----\n";

const SAMPLE: CimisyConfigBlobInput = {
  repo: "acme/site",
  branch: "main",
  appId: "123456",
  privateKey: PEM,
  clientId: "Iv1.0123456789abcdef",
  clientSecret: "secret-client-value",
  sessionSecret: "0123456789abcdef0123456789abcdef",
};

/** Re-encodes a decoded blob after mutating the JSON payload — how a tampered/older blob is simulated. */
function encodeRaw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function omit<T extends object>(source: T, ...keys: Array<keyof T>): Partial<T> {
  const copy = { ...source };
  for (const key of keys) delete copy[key];
  return copy;
}

describe("CIMISY_CONFIG blob codec", () => {
  it("round-trips every field, stamping the current version", () => {
    const decoded = decodeCimisyConfigBlob(encodeCimisyConfigBlob(SAMPLE));
    expect(decoded).toEqual({ v: CIMISY_CONFIG_BLOB_VERSION, ...SAMPLE });
  });

  it("survives a multi-line PEM without any escaping on the caller's part", () => {
    const decoded = decodeCimisyConfigBlob(encodeCimisyConfigBlob(SAMPLE));
    expect(decoded.privateKey).toBe(PEM);
    expect(decoded.privateKey).toContain("\n");
  });

  it("emits a single shell-safe line — no newlines, quotes, or padding", () => {
    const blob = encodeCimisyConfigBlob(SAMPLE);
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("omits branch when unset, and the decoder leaves it undefined", () => {
    const decoded = decodeCimisyConfigBlob(encodeCimisyConfigBlob(omit(SAMPLE, "branch") as CimisyConfigBlobInput));
    expect(decoded.branch).toBeUndefined();
  });

  it("tolerates surrounding whitespace from a sloppy paste", () => {
    expect(decodeCimisyConfigBlob(`  ${encodeCimisyConfigBlob(SAMPLE)}\n`).repo).toBe("acme/site");
  });

  it("drops unknown keys rather than passing them through to githubSource()", () => {
    const blob = encodeRaw({ v: 1, ...SAMPLE, allowInProduction: true, __proto__hack: "x" });
    expect(Object.keys(decodeCimisyConfigBlob(blob)).sort()).toEqual(
      ["appId", "branch", "clientId", "clientSecret", "privateKey", "repo", "sessionSecret", "v"].sort(),
    );
  });
});

describe("CIMISY_CONFIG blob rejection paths", () => {
  const expectCode = (blob: string, code: string) => {
    try {
      decodeCimisyConfigBlob(blob);
    } catch (err) {
      expect(err).toBeInstanceOf(CimisyError);
      expect((err as CimisyError).code).toBe(code);
      return err as CimisyError;
    }
    throw new Error("expected decodeCimisyConfigBlob to throw");
  };

  it("rejects non-base64url characters (line-wrapped or shell-mangled paste)", () => {
    expectCode("not base64url!", "INVALID_CONFIG_BLOB");
    expectCode(`${encodeCimisyConfigBlob(SAMPLE).slice(0, 20)}\n${encodeCimisyConfigBlob(SAMPLE).slice(20)}`, "INVALID_CONFIG_BLOB");
    expectCode("", "INVALID_CONFIG_BLOB");
  });

  it("rejects a truncated blob", () => {
    // 8 base64url chars = the first 6 JSON bytes (`{"v":1`) — decodes fine, parses as nothing.
    expectCode(encodeCimisyConfigBlob(SAMPLE).slice(0, 8), "INVALID_CONFIG_BLOB");
  });

  it("rejects valid base64url that isn't a JSON object", () => {
    expectCode(Buffer.from("[1,2,3]", "utf8").toString("base64url"), "INVALID_CONFIG_BLOB");
    expectCode(Buffer.from('"a string"', "utf8").toString("base64url"), "INVALID_CONFIG_BLOB");
  });

  it("rejects an unknown format version with a distinct code (a newer cimisy wrote it)", () => {
    expectCode(encodeRaw({ ...SAMPLE, v: 2 }), "UNSUPPORTED_CONFIG_BLOB_VERSION");
    expectCode(encodeRaw({ ...SAMPLE, v: "1" }), "UNSUPPORTED_CONFIG_BLOB_VERSION");
  });

  it("rejects an unversioned payload as malformed rather than as a version mismatch", () => {
    expectCode(encodeRaw({ ...SAMPLE }), "INVALID_CONFIG_BLOB");
  });

  it("names missing required fields", () => {
    const err = expectCode(encodeRaw({ v: 1, ...omit(SAMPLE, "clientSecret", "sessionSecret") }), "INVALID_CONFIG_BLOB");
    expect(err.message).toContain("clientSecret");
    expect(err.message).toContain("sessionSecret");
  });

  it("rejects a blank required field, not just an absent one", () => {
    expectCode(encodeRaw({ v: 1, ...SAMPLE, privateKey: "" }), "INVALID_CONFIG_BLOB");
  });

  it("never echoes blob contents in an error message — it holds a private key and two secrets", () => {
    const tampered = `${encodeCimisyConfigBlob(SAMPLE)}AAAA`;
    for (const blob of [tampered, encodeRaw({ ...SAMPLE, v: 9 }), encodeRaw({ v: 1, repo: "acme/site" })]) {
      let message = "";
      try {
        decodeCimisyConfigBlob(blob);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(blob);
      expect(message).not.toContain(SAMPLE.clientSecret);
      expect(message).not.toContain(SAMPLE.sessionSecret);
      expect(message).not.toContain("PRIVATE KEY");
    }
  });
});
