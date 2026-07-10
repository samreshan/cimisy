import { randomUUID } from "node:crypto";
import type { CimisyConfig } from "../config/define-config.js";
import type { ImageFieldDefinition } from "../config/fields/image.js";
import { UnsafePathError, ValidationError } from "../shared/errors.js";
import { slugify } from "../shared/slug.js";

/**
 * 5MB, checked against the base64 string length before ever decoding —
 * decoding first would mean spending the memory/CPU on an oversized
 * payload before rejecting it. Base64 expands bytes by ~4/3, so the
 * string-length bound is scaled accordingly; the actual decoded buffer is
 * re-checked below too as a second, authoritative guard (the base64
 * estimate can be a little loose around padding).
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4;

export interface SniffedImageType {
  extension: string;
  contentType: string;
}

/**
 * Identifies an image format from its actual bytes rather than trusting a
 * client-supplied filename/extension/content-type — this is an allowlist
 * by construction: only formats with a signature check below are ever
 * accepted, so SVG (script-capable, a real XSS vector for user-uploaded
 * "images") is excluded by omission, not by a denylist that could miss a
 * variant.
 */
export function sniffImageType(buffer: Buffer): SniffedImageType | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { extension: "png", contentType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { extension: "gif", contentType: "image/gif" };
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { extension: "webp", contentType: "image/webp" };
  }
  return null;
}

/** Decodes and size-checks a base64 upload payload, failing closed on anything that isn't a recognized image format. */
export function decodeUploadedImage(base64: string): { buffer: Buffer; type: SniffedImageType } {
  if (base64.length === 0 || base64.length > MAX_BASE64_LENGTH) {
    throw new ValidationError(`Upload exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB size limit.`, null);
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new ValidationError(`Upload exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB size limit.`, null);
  }
  const type = sniffImageType(buffer);
  if (!type) {
    throw new ValidationError("Upload is not a recognized image format (png, jpg, gif, webp).", null);
  }
  return { buffer, type };
}

/**
 * Builds a safe, collision-resistant repo-relative path for an upload. The
 * extension is always the server-sniffed one (see decodeUploadedImage),
 * never the client-claimed one — this rules out extension-confusion
 * tricks (e.g. a PNG-signature file named "a.png.php") by construction.
 * A random suffix sidesteps needing a read-then-write existence check
 * (which would be a TOCTOU race against a concurrent upload) to avoid
 * silently overwriting an unrelated file that happens to slugify to the
 * same name.
 */
export function buildMediaPath(directory: string, originalFilename: string, extension: string): string {
  const withoutExtension = originalFilename.replace(/\.[^./]+$/, "");
  let base: string;
  try {
    base = slugify(withoutExtension);
  } catch {
    base = "upload";
  }
  if (!base) base = "upload";
  const suffix = randomUUID().slice(0, 8);
  return `${directory}/${base}-${suffix}.${extension}`;
}

/** Directory must match one of the project's configured image-field directories exactly — not just as a prefix, which could otherwise let "uploads-secret" pass a check meant to allow only "uploads". */
export function assertConfiguredDirectory(directory: string, configuredDirectories: readonly string[]): void {
  if (!configuredDirectories.includes(directory)) {
    throw new UnsafePathError(`"${directory}" is not a configured image-field directory.`);
  }
}

/** A path is only ever readable through the media API if it falls under one of the configured image directories — blocks reading arbitrary repo files (e.g. ".cimisy/users.yaml") through what's meant to be an image-only endpoint. */
export function assertPathUnderConfiguredDirectory(path: string, configuredDirectories: readonly string[]): void {
  const ok = configuredDirectories.some((dir) => path === dir || path.startsWith(`${dir}/`));
  if (!ok) {
    throw new UnsafePathError(`"${path}" is not under a configured image-field directory.`);
  }
}

/** Every distinct `directory` any `fields.image()` in the project's schema declares — the allowlist the media API validates uploads/reads against. */
export function getConfiguredImageDirectories(cimisyConfig: CimisyConfig): string[] {
  const directories = new Set<string>();
  for (const collection of Object.values(cimisyConfig.collections)) {
    for (const field of Object.values(collection.schema)) {
      if (field.kind === "image") {
        directories.add((field as ImageFieldDefinition).directory);
      }
    }
  }
  return [...directories];
}
