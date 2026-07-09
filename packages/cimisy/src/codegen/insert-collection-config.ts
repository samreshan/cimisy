import ts from "typescript";
import type { FieldProposal, ProposedFieldKind, CollectionSchemaProposal } from "../scan/infer-schema.js";

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
    `${baseIndent}${name}: collection({`,
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

  const nameCollision = collectionsObj.properties.some(
    (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === options.name,
  );
  if (nameCollision) {
    throw new Error(`cimisy.config.ts already has a collection named "${options.name}".`);
  }

  const closeBraceIndex = collectionsObj.getEnd() - 1;

  if (collectionsObj.properties.length === 0) {
    // No sibling property to copy indentation from — derive one level deeper than the `collections: {` line itself.
    const objStartLine = withImports.slice(0, collectionsObj.getStart(source)).split("\n").pop() ?? "";
    const objLineIndent = /^\s*/.exec(objStartLine)?.[0] ?? "";
    const baseIndent = `${objLineIndent}  `;
    const newPropertyText = buildCollectionSourceText(options, baseIndent);
    const openBraceIndex = collectionsObj.getStart(source) + 1;
    return withImports.slice(0, openBraceIndex) + `\n${newPropertyText}\n${objLineIndent}` + withImports.slice(closeBraceIndex);
  }

  const lastProp = collectionsObj.properties[collectionsObj.properties.length - 1]!;
  // Match the indentation of the existing last property for the new property line, but the closing
  // brace itself sits one level shallower, aligned with the `collections: {` line — they're not the same.
  const lastPropLine = withImports.slice(0, lastProp.getStart(source)).split("\n").pop() ?? "";
  const propertyIndent = /^\s*/.exec(lastPropLine)?.[0] ?? "";
  const objStartLine = withImports.slice(0, collectionsObj.getStart(source)).split("\n").pop() ?? "";
  const closingIndent = /^\s*/.exec(objStartLine)?.[0] ?? "";
  const newPropertyText = buildCollectionSourceText(options, propertyIndent);
  return withImports.slice(0, lastProp.getEnd()) + `,\n${newPropertyText}\n${closingIndent}` + withImports.slice(closeBraceIndex);
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
