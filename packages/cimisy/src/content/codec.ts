import { parseDocument, stringify as stringifyYaml } from "yaml";
import type { BlockNode, BlocksFieldDefinition } from "../config/fields/blocks.js";
import type { FieldDefinition } from "../config/fields/types.js";
import { parseMdxToBlocks } from "../mdx/parse.js";
import { serializeBlocksToMdx } from "../mdx/serialize.js";
import { ValidationError } from "../shared/errors.js";

const FRONTMATTER_DELIMITER = "---";
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function serializeEntry(schema: Record<string, FieldDefinition>, values: Record<string, unknown>): string {
  const frontmatter: Record<string, unknown> = {};
  let bodyMarkdown = "";
  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    const value = values[fieldName];
    if (fieldDef.kind === "blocks") {
      const blocksField = fieldDef as BlocksFieldDefinition;
      bodyMarkdown = serializeBlocksToMdx((value as BlockNode[] | undefined) ?? [], blocksField.registry);
    } else if (fieldDef.location === "frontmatter") {
      frontmatter[fieldName] = value instanceof Date ? value.toISOString() : value;
    }
  }
  const yamlText = stringifyYaml(frontmatter).trimEnd();
  return `${FRONTMATTER_DELIMITER}\n${yamlText}\n${FRONTMATTER_DELIMITER}\n\n${bodyMarkdown}\n`;
}

export function parseEntry(
  schema: Record<string, FieldDefinition>,
  path: string,
  raw: string,
): Record<string, unknown> {
  const { frontmatter, body } = splitFrontmatter(raw, path);
  const values: Record<string, unknown> = {};
  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    if (fieldDef.kind === "blocks") {
      const blocksField = fieldDef as BlocksFieldDefinition;
      try {
        values[fieldName] = parseMdxToBlocks(body, blocksField.registry);
      } catch (err) {
        if (err instanceof ValidationError) {
          throw new ValidationError(`Field "${fieldName}" in ${path}: ${err.message}`, err.issues);
        }
        throw err;
      }
      continue;
    }
    if (fieldDef.location !== "frontmatter") continue;
    const result = fieldDef.zodSchema.safeParse(frontmatter[fieldName]);
    if (!result.success) {
      throw new ValidationError(`Field "${fieldName}" in ${path} failed validation.`, result.error.issues);
    }
    values[fieldName] = result.data;
  }
  return values;
}

function splitFrontmatter(raw: string, path: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) {
    throw new ValidationError(`File "${path}" is missing YAML frontmatter delimited by "---".`, null);
  }
  const [, yamlText, body] = match;
  // parseDocument (rather than the bare `parse` shortcut) is deliberate:
  // `parse` only *warns* to the console on things like an unresolved
  // `!!js/function` tag and then silently continues with a best-effort
  // fallback value — inert (yaml's Core schema has no JS tags to execute),
  // but too permissive for a security-first parser. Treating any warning
  // the same as a hard error gives fail-closed behavior: anomalous
  // frontmatter is rejected outright rather than tolerated.
  const doc = parseDocument(yamlText ?? "");
  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    const issues = [...doc.errors, ...doc.warnings].map((e) => e.message).join("; ");
    throw new ValidationError(`Frontmatter in "${path}" is not valid YAML: ${issues}`, null);
  }
  const parsed: unknown = doc.toJS();
  if (parsed !== null && parsed !== undefined && typeof parsed !== "object") {
    throw new ValidationError(`Frontmatter in "${path}" must be a YAML mapping.`, null);
  }
  return { frontmatter: (parsed as Record<string, unknown> | null) ?? {}, body: (body ?? "").trim() };
}
