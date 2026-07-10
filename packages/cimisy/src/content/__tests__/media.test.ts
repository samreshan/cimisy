import { describe, expect, it } from "vitest";
import { UnsafePathError, ValidationError } from "../../shared/errors.js";
import {
  MAX_UPLOAD_BYTES,
  assertConfiguredDirectory,
  assertPathUnderConfiguredDirectory,
  buildMediaPath,
  decodeUploadedImage,
  sniffImageType,
} from "../media.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);
const GIF_BYTES = Buffer.from("GIF89a" + "\x01\x02\x03");
const WEBP_BYTES = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from([1, 2, 3])]);

describe("sniffImageType", () => {
  it("identifies PNG by signature", () => {
    expect(sniffImageType(PNG_BYTES)).toEqual({ extension: "png", contentType: "image/png" });
  });
  it("identifies JPEG by signature", () => {
    expect(sniffImageType(JPEG_BYTES)).toEqual({ extension: "jpg", contentType: "image/jpeg" });
  });
  it("identifies GIF (both GIF87a and GIF89a) by signature", () => {
    expect(sniffImageType(GIF_BYTES)).toEqual({ extension: "gif", contentType: "image/gif" });
    expect(sniffImageType(Buffer.from("GIF87a"))).toEqual({ extension: "gif", contentType: "image/gif" });
  });
  it("identifies WEBP by RIFF/WEBP signature", () => {
    expect(sniffImageType(WEBP_BYTES)).toEqual({ extension: "webp", contentType: "image/webp" });
  });
  it("returns null for an SVG (deliberately unsupported — script-capable format)", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(sniffImageType(svg)).toBeNull();
  });
  it("returns null for arbitrary non-image bytes", () => {
    expect(sniffImageType(Buffer.from("not an image"))).toBeNull();
  });
  it("returns null for an empty buffer", () => {
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe("decodeUploadedImage", () => {
  it("decodes a valid base64-encoded PNG", () => {
    const { buffer, type } = decodeUploadedImage(PNG_BYTES.toString("base64"));
    expect(buffer.equals(PNG_BYTES)).toBe(true);
    expect(type.extension).toBe("png");
  });

  it("rejects empty content", () => {
    expect(() => decodeUploadedImage("")).toThrow(ValidationError);
  });

  it("rejects a payload whose base64 length implies it exceeds the size cap, before decoding", () => {
    const oversizedBase64 = "A".repeat(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 100);
    expect(() => decodeUploadedImage(oversizedBase64)).toThrow(ValidationError);
  });

  it("rejects a decoded buffer that exceeds the size cap even if the base64-length estimate underestimated it", () => {
    const oversized = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_UPLOAD_BYTES)]);
    expect(() => decodeUploadedImage(oversized.toString("base64"))).toThrow(ValidationError);
  });

  it("rejects a non-image payload (e.g. an SVG, or arbitrary bytes) with a ValidationError, not a silent pass-through", () => {
    const svg = Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64");
    expect(() => decodeUploadedImage(svg)).toThrow(ValidationError);
  });

  it("rejects a file whose extension claims one format but whose bytes are another (extension confusion) — the type is derived from bytes only, so this just means the sniffed type wins, not that upload fails, but proves the extension is never trusted", () => {
    // A JPEG's bytes, uploaded regardless of what a client might have called it.
    const { type } = decodeUploadedImage(JPEG_BYTES.toString("base64"));
    expect(type.extension).toBe("jpg");
  });
});

describe("buildMediaPath", () => {
  it("builds a path under the given directory with the sniffed extension, ignoring any extension the client's filename had", () => {
    const path = buildMediaPath("uploads", "my-photo.png", "jpg");
    expect(path).toMatch(/^uploads\/my-photo-[0-9a-f]{8}\.jpg$/);
  });

  it("slugifies a filename with unsafe characters", () => {
    const path = buildMediaPath("uploads", "My Photo!! (final).png", "png");
    expect(path).toMatch(/^uploads\/my-photo-final-[0-9a-f]{8}\.png$/);
  });

  it("falls back to a generic base name when the filename has no sluggable characters", () => {
    const path = buildMediaPath("uploads", "😀😀😀.png", "png");
    expect(path).toMatch(/^uploads\/upload-[0-9a-f]{8}\.png$/);
  });

  it("produces a different path on each call (collision resistance)", () => {
    const a = buildMediaPath("uploads", "a.png", "png");
    const b = buildMediaPath("uploads", "a.png", "png");
    expect(a).not.toBe(b);
  });
});

describe("assertConfiguredDirectory", () => {
  it("accepts a directory that's in the configured list", () => {
    expect(() => assertConfiguredDirectory("uploads", ["uploads", "images"])).not.toThrow();
  });
  it("rejects a directory not in the configured list", () => {
    expect(() => assertConfiguredDirectory("secrets", ["uploads"])).toThrow(UnsafePathError);
  });
  it("rejects a directory that's merely a prefix of a configured one (no partial-match allowlist bypass)", () => {
    expect(() => assertConfiguredDirectory("uploads-secret", ["uploads"])).toThrow(UnsafePathError);
  });
});

describe("assertPathUnderConfiguredDirectory", () => {
  it("accepts a path nested under a configured directory", () => {
    expect(() => assertPathUnderConfiguredDirectory("uploads/a.png", ["uploads"])).not.toThrow();
  });
  it("rejects a path outside every configured directory (e.g. the RBAC roster file)", () => {
    expect(() => assertPathUnderConfiguredDirectory(".cimisy/users.yaml", ["uploads"])).toThrow(UnsafePathError);
  });
  it("rejects a sibling directory that merely shares a prefix", () => {
    expect(() => assertPathUnderConfiguredDirectory("uploads-secret/a.png", ["uploads"])).toThrow(UnsafePathError);
  });
});
