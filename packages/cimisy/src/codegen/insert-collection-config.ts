import ts from "typescript";
import { RESERVED_TOP_LEVEL_KEYS } from "../config/define-config.js";
import type { FieldProposal, ProposedFieldKind, CollectionSchemaProposal } from "../scan/infer-schema.js";
import { objectKeyFor, propertyKeyText } from "./source-edit-utils.js";

export interface InsertCollectionOptions {
  /** Config property key / collection identifier, e.g. "news". */
  name: string;
  label: string;
  /** Content glob, e.g. "news/*.mdx". */
  path: string;
  proposal: CollectionSchemaProposal;
}

export function humanizeLabel(name: string): string {
  const withSpaces = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  const trimmed = withSpaces.trim();
  return trimmed.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * A scanned variable name is a JS identifier (`POSTS`, `teamMembers`,
 * `BLOG_POSTS`) but config keys must satisfy define-config's
 * KEY_SEGMENT_PATTERN (lowercase/digits/single-hyphens — they become URLs
 * and git branch components) and must not shadow a reserved admin screen.
 * Import must normalize here, or it writes a config that cimisy's own
 * runtime refuses to load.
 */
export function toCollectionKey(variableName: string): string {
  const key = variableName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2") // acronym runs: APIRoutes → API-Routes
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2") // camelCase boundaries
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // underscores & anything else → hyphen
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/, "");
  const fallback = key || "imported";
  return RESERVED_TOP_LEVEL_KEYS.has(fallback) ? `${fallback}-collection` : fallback;
}

function fieldFactoryCall(field: FieldProposal, collectionName: string): string {
  const label = humanizeLabel(field.name);
  const kind: ProposedFieldKind = field.proposedKind;
  switch (kind) {
    case "text":
      return `fields.text({ label: ${JSON.stringify(label)} })`;
    case "image":
      return `fields.image({ label: ${JSON.stringify(label)}, directory: ${JSON.stringify(`public/images/${collectionName}`)} })`;
    case "array-of-text":
      return `fields.array(fields.text({ label: ${JSON.stringify(label)} }))`;
    case "boolean":
      return `fields.boolean({ label: ${JSON.stringify(label)} })`;
    case "number":
      return `fields.number({ label: ${JSON.stringify(label)} })`;
  }
}

function buildCollectionSourceText(options: InsertCollectionOptions, baseIndent: string): string {
  const { name, label, path: contentPath, proposal } = options;
  const innerIndent = `${baseIndent}  `;
  const fieldIndent = `${innerIndent}  `;

  const fieldLines = [
    `${fieldIndent}${proposal.slugField}: fields.slug({ source: ${JSON.stringify(proposal.slugSourceField)} }),`,
    ...proposal.fields.map((f) => `${fieldIndent}${f.name}: ${fieldFactoryCall(f, name)},`),
  ];

  return [
    `${baseIndent}${objectKeyFor(name)}: collection({`,
    `${innerIndent}label: ${JSON.stringify(label)},`,
    `${innerIndent}path: ${JSON.stringify(contentPath)},`,
    `${innerIndent}slugField: ${JSON.stringify(proposal.slugField)},`,
    `${innerIndent}schema: {`,
    ...fieldLines,
    `${innerIndent}},`,
    `${baseIndent}}),`,
  ].join("\n");
}

/** Adds `requiredNames` to an existing named import from `moduleSpecifier`, or inserts a new import statement if none exists. Idempotent — already-imported names are left alone. */
export function ensureNamedImport(sourceText: string, moduleSpecifier: string, requiredNames: string[]): string {
  const source = ts.createSourceFile("config.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== moduleSpecifier) continue;

    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      const existingNames = namedBindings.elements.map((el) => el.name.text);
      const missing = requiredNames.filter((n) => !existingNames.includes(n));
      if (missing.length === 0) return sourceText;
      if (namedBindings.elements.length > 0) {
        const lastElement = namedBindings.elements[namedBindings.elements.length - 1]!;
        const insertPos = lastElement.getEnd();
        return sourceText.slice(0, insertPos) + `, ${missing.join(", ")}` + sourceText.slice(insertPos);
      }
      const insertPos = namedBindings.getStart(source) + 1;
      return sourceText.slice(0, insertPos) + missing.join(", ") + sourceText.slice(insertPos);
    }

    // Import exists for this module but has no named-import clause (e.g. a bare `import "cimisy/config"`) — add a sibling named-import statement.
    const insertPos = statement.getEnd();
    return (
      sourceText.slice(0, insertPos) +
      `\nimport { ${requiredNames.join(", ")} } from ${JSON.stringify(moduleSpecifier)};` +
      sourceText.slice(insertPos)
    );
  }

  const lastImport = [...source.statements].filter(ts.isImportDeclaration).pop();
  const newImportLine = `import { ${requiredNames.join(", ")} } from ${JSON.stringify(moduleSpecifier)};`;
  if (lastImport) {
    const insertPos = lastImport.getEnd();
    return sourceText.slice(0, insertPos) + `\n${newImportLine}` + sourceText.slice(insertPos);
  }
  return `${newImportLine}\n${sourceText}`;
}

function findCollectionsObjectLiteral(source: ts.SourceFile): ts.ObjectLiteralExpression | null {
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "config" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const prop of node.arguments[0].properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === "collections" &&
          ts.isObjectLiteralExpression(prop.initializer)
        ) {
          found = prop.initializer;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Splices a new property into an existing object literal, preserving the
 * rest of the file untouched — matches the indentation of the last sibling
 * property when one exists, or derives one level deeper than the object's
 * own opening line when it's empty. Shared by every "insert a new
 * collection/singleton/section/page into cimisy.config.ts" codemod so the
 * whitespace-matching logic lives in exactly one place.
 */
export function insertObjectLiteralProperty(
  sourceText: string,
  source: ts.SourceFile,
  obj: ts.ObjectLiteralExpression,
  buildPropertyText: (indent: string) => string,
): string {
  const closeBraceIndex = obj.getEnd() - 1;

  if (obj.properties.length === 0) {
    // No sibling property to copy indentation from — derive one level deeper than the object's own opening line.
    const objStartLine = sourceText.slice(0, obj.getStart(source)).split("\n").pop() ?? "";
    const objLineIndent = /^\s*/.exec(objStartLine)?.[0] ?? "";
    const baseIndent = `${objLineIndent}  `;
    const newPropertyText = buildPropertyText(baseIndent);
    const openBraceIndex = obj.getStart(source) + 1;
    return sourceText.slice(0, openBraceIndex) + `\n${newPropertyText}\n${objLineIndent}` + sourceText.slice(closeBraceIndex);
  }

  const lastProp = obj.properties[obj.properties.length - 1]!;
  // Match the indentation of the existing last property for the new property line, but the closing
  // brace itself sits one level shallower, aligned with the object's own opening line — they're not the same.
  const lastPropLine = sourceText.slice(0, lastProp.getStart(source)).split("\n").pop() ?? "";
  const propertyIndent = /^\s*/.exec(lastPropLine)?.[0] ?? "";
  const objStartLine = sourceText.slice(0, obj.getStart(source)).split("\n").pop() ?? "";
  const closingIndent = /^\s*/.exec(objStartLine)?.[0] ?? "";
  const newPropertyText = buildPropertyText(propertyIndent);
  return sourceText.slice(0, lastProp.getEnd()) + `,\n${newPropertyText}\n${closingIndent}` + sourceText.slice(closeBraceIndex);
}

/**
 * Inserts a new `<name>: collection({...})` entry into an existing
 * cimisy.config.ts's `collections: {...}` object, preserving the rest of
 * the file untouched (text splice at the object literal's boundary, never
 * a full-file regenerate — hand edits elsewhere in the file survive).
 */
export function insertCollectionIntoConfig(sourceText: string, options: InsertCollectionOptions): string {
  const withImports = ensureNamedImport(sourceText, "cimisy/config", ["collection", "fields"]);
  const source = ts.createSourceFile("cimisy.config.ts", withImports, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const collectionsObj = findCollectionsObjectLiteral(source);
  if (!collectionsObj) {
    throw new Error(
      "Could not find a `collections: {...}` object inside a `config({...})` call in cimisy.config.ts — the file may not match the expected shape.",
    );
  }

  const nameCollision = collectionsObj.properties.some((p) => propertyKeyText(p) === options.name);
  if (nameCollision) {
    throw new Error(`cimisy.config.ts already has a collection named "${options.name}".`);
  }

  return insertObjectLiteralProperty(withImports, source, collectionsObj, (indent) => buildCollectionSourceText(options, indent));
}

/** A fresh cimisy.config.ts matching the README quickstart shape, with an empty collections object ready for insertCollectionIntoConfig. */
export function scaffoldConfigFile(): string {
  return [
    `import { collection, config, fields } from "cimisy/config";`,
    `import { localSource } from "cimisy/adapters/local";`,
    ``,
    `export default config({`,
    `  source: localSource({ rootDir: "./content" }),`,
    ``,
    `  collections: {},`,
    `});`,
    ``,
  ].join("\n");
}
