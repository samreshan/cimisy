import type { FieldDefinition } from "../config/fields/types.js";
import { ValidationError } from "../shared/errors.js";

/**
 * Write-side counterpart of the codecs' parse-time validation: everything
 * that would be rejected when the file is read back must be rejected
 * *before* it is written, or a "successful" save produces an entry that
 * can never be loaded again.
 *
 * Validates every frontmatter field against its zod schema, collecting all
 * failures into one ValidationError whose issue paths are prefixed with the
 * field name (`["title", ...]`) so the admin UI can attach each message to
 * the offending input. Returns the schema-normalized values (zod defaults
 * applied), which is what should be serialized — never the raw input.
 *
 * `blocks` fields are skipped: their value is validated structurally by the
 * MDX serializer on the same write path.
 */
export function validateFieldValues(
  schema: Record<string, FieldDefinition>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const issues: unknown[] = [];
  const normalized: Record<string, unknown> = { ...values };
  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    if (fieldDef.kind === "blocks" || fieldDef.location !== "frontmatter") continue;
    const result = fieldDef.zodSchema.safeParse(values[fieldName]);
    if (result.success) {
      normalized[fieldName] = result.data;
    } else {
      issues.push(...result.error.issues.map((issue) => ({ ...issue, path: [fieldName, ...issue.path] })));
    }
  }
  if (issues.length > 0) {
    throw new ValidationError("Some fields failed validation.", issues);
  }
  return normalized;
}
