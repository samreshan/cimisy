import ts from "typescript";
import type { StaticFieldProposal, StaticSchemaProposal } from "../scan/infer-static-schema.js";
import { ensureNamedImport, insertObjectLiteralProperty } from "./insert-collection-config.js";
import { objectKeyFor } from "./source-edit-utils.js";

export interface InsertSingletonOptions {
  name: string;
  label: string;
  /** e.g. "content/footer.yaml". */
  path: string;
  proposal: StaticSchemaProposal;
}

export interface InsertSectionOptions {
  pageKey: string;
  pageLabel: string;
  pageRoute?: string;
  /** Only used when this page doesn't exist in the config file yet, e.g. "content/pages/home". */
  pagePath: string;
  sectionKey: string;
  sectionLabel: string;
  proposal: StaticSchemaProposal;
}

function staticFieldFactoryCall(field: StaticFieldProposal, contentKey: string): string {
  switch (field.proposedKind) {
    case "text":
      return `fields.text({ label: ${JSON.stringify(field.label)} })`;
    case "image":
      return `fields.image({ label: ${JSON.stringify(field.label)}, directory: ${JSON.stringify(`public/images/${contentKey}`)} })`;
    case "blocks":
      return `fields.blocks({ label: ${JSON.stringify(field.label)}, blocks: { paragraph: blocks.paragraph() } })`;
  }
}

function buildSchemaLines(proposal: StaticSchemaProposal, contentKey: string, indent: string): string[] {
  return proposal.fields.map((f) => `${indent}${objectKeyFor(f.name)}: ${staticFieldFactoryCall(f, contentKey)},`);
}

function buildSingletonSourceText(options: InsertSingletonOptions, baseIndent: string): string {
  const inner = `${baseIndent}  `;
  const fieldIndent = `${inner}  `;
  return [
    `${baseIndent}${options.name}: singleton({`,
    `${inner}label: ${JSON.stringify(options.label)},`,
    `${inner}path: ${JSON.stringify(options.path)},`,
    `${inner}schema: {`,
    ...buildSchemaLines(options.proposal, options.name, fieldIndent),
    `${inner}},`,
    `${baseIndent}}),`,
  ].join("\n");
}

function buildSectionSourceText(options: InsertSectionOptions, baseIndent: string): string {
  const inner = `${baseIndent}  `;
  const fieldIndent = `${inner}  `;
  return [
    `${baseIndent}${options.sectionKey}: section({`,
    `${inner}label: ${JSON.stringify(options.sectionLabel)},`,
    `${inner}schema: {`,
    ...buildSchemaLines(options.proposal, options.sectionKey, fieldIndent),
    `${inner}},`,
    `${baseIndent}}),`,
  ].join("\n");
}

function buildPageWithSectionSourceText(options: InsertSectionOptions, baseIndent: string): string {
  const inner = `${baseIndent}  `;
  const sectionsIndent = `${inner}  `;
  const lines = [`${baseIndent}${options.pageKey}: page({`, `${inner}label: ${JSON.stringify(options.pageLabel)},`];
  if (options.pageRoute) lines.push(`${inner}route: ${JSON.stringify(options.pageRoute)},`);
  lines.push(
    `${inner}path: ${JSON.stringify(options.pagePath)},`,
    `${inner}sections: {`,
    buildSectionSourceText(options, sectionsIndent),
    `${inner}},`,
    `${baseIndent}}),`,
  );
  return lines.join("\n");
}

function requiredFieldImportNames(proposal: StaticSchemaProposal): string[] {
  return proposal.fields.some((f) => f.proposedKind === "blocks") ? ["fields", "blocks"] : ["fields"];
}

function findConfigObjectArgument(source: ts.SourceFile): ts.ObjectLiteralExpression | null {
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
      found = node.arguments[0];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Finds `name: {...}` (a property whose value is itself an object literal — e.g. `singletons`/`pages`) inside `obj`. */
function findNamedObjectProperty(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralExpression | null {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === name &&
      ts.isObjectLiteralExpression(prop.initializer)
    ) {
      return prop.initializer;
    }
  }
  return null;
}

/** Finds `name: someCall({...})` (e.g. `homeKey: page({...})`) inside `obj`, returning the call's own first-argument object literal — or null if `name` isn't present in this shape. */
function findNamedCallArgumentObject(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralExpression | null {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === name &&
      ts.isCallExpression(prop.initializer) &&
      prop.initializer.arguments[0] &&
      ts.isObjectLiteralExpression(prop.initializer.arguments[0])
    ) {
      return prop.initializer.arguments[0];
    }
  }
  return null;
}

/** Authoritative top-level name collision check — a singleton/page shares the same key namespace as collections at runtime (define-config.ts's claimKey). */
function assertNoTopLevelNameCollision(configObj: ts.ObjectLiteralExpression, name: string): void {
  for (const topKey of ["collections", "singletons", "pages"]) {
    const obj = findNamedObjectProperty(configObj, topKey);
    if (!obj) continue;
    const collision = obj.properties.some((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name);
    if (collision) {
      throw new Error(`cimisy.config.ts already has a ${topKey.slice(0, -1)} named "${name}".`);
    }
  }
}

/**
 * Reads the `path:` a page in the *live* config already declared (so a
 * second section added to it lands in the same directory), falling back to
 * define-config.ts's own default formula (`content/pages/<pageKey>`) when
 * the page exists but omitted an explicit path. Returns null when the page
 * doesn't exist in configText at all — the caller then picks a fresh path.
 */
export function resolveExistingPagePath(configText: string, pageKey: string): string | null {
  const source = ts.createSourceFile("cimisy.config.ts", configText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const configObj = findConfigObjectArgument(source);
  if (!configObj) return null;
  const pagesObj = findNamedObjectProperty(configObj, "pages");
  if (!pagesObj) return null;
  const pageOptionsObj = findNamedCallArgumentObject(pagesObj, pageKey);
  if (!pageOptionsObj) return null;
  for (const prop of pageOptionsObj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === "path" &&
      ts.isStringLiteralLike(prop.initializer)
    ) {
      return prop.initializer.text;
    }
  }
  return `content/pages/${pageKey}`;
}

/**
 * Inserts a new top-level `<name>: singleton({...})` — creating the
 * `singletons: {...}` object first if it doesn't exist yet. Mirrors
 * insertCollectionIntoConfig's splice-not-regenerate approach.
 */
export function insertSingletonIntoConfig(sourceText: string, options: InsertSingletonOptions): string {
  const withImports = ensureNamedImport(sourceText, "cimisy/config", ["singleton", ...requiredFieldImportNames(options.proposal)]);
  const source = ts.createSourceFile("cimisy.config.ts", withImports, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const configObj = findConfigObjectArgument(source);
  if (!configObj) {
    throw new Error("Could not find a `config({...})` call in cimisy.config.ts — the file may not match the expected shape.");
  }
  assertNoTopLevelNameCollision(configObj, options.name);

  const singletonsObj = findNamedObjectProperty(configObj, "singletons");
  if (singletonsObj) {
    return insertObjectLiteralProperty(withImports, source, singletonsObj, (indent) => buildSingletonSourceText(options, indent));
  }
  return insertObjectLiteralProperty(withImports, source, configObj, (indent) => {
    const inner = `${indent}  `;
    return [`${indent}singletons: {`, buildSingletonSourceText(options, inner), `${indent}},`].join("\n");
  });
}

/**
 * Inserts a new `<sectionKey>: section({...})` under `pages.<pageKey>`,
 * handling three shapes: no `pages` property at all (creates it, the page,
 * and the section together); `pages` exists but `pageKey` doesn't (inserts
 * a new page); `pageKey` already exists (e.g. a prior static or collection
 * import already claimed this page — inserts into its existing `sections`
 * object). All three throw on a name collision at the level they insert
 * into (top-level for a new page key, sibling-section for an existing
 * page) — this is the authoritative check; the scan report's own
 * collision tracking is best-effort only.
 */
export function insertSectionIntoPageConfig(sourceText: string, options: InsertSectionOptions): string {
  // Probe the *original* text first (no imports added yet) so we only ever request the imports the chosen branch actually needs.
  const probeSource = ts.createSourceFile("cimisy.config.ts", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const probeConfigObj = findConfigObjectArgument(probeSource);
  if (!probeConfigObj) {
    throw new Error("Could not find a `config({...})` call in cimisy.config.ts — the file may not match the expected shape.");
  }
  const probePagesObj = findNamedObjectProperty(probeConfigObj, "pages");
  const pageAlreadyExists = probePagesObj ? findNamedCallArgumentObject(probePagesObj, options.pageKey) !== null : false;

  const importNames = [
    "section",
    ...(pageAlreadyExists ? [] : ["page"]),
    ...requiredFieldImportNames(options.proposal),
  ];
  const withImports = ensureNamedImport(sourceText, "cimisy/config", importNames);
  const source = ts.createSourceFile("cimisy.config.ts", withImports, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const configObj = findConfigObjectArgument(source)!;
  const pagesObj = findNamedObjectProperty(configObj, "pages");

  if (pagesObj) {
    const pageOptionsObj = findNamedCallArgumentObject(pagesObj, options.pageKey);
    if (pageOptionsObj) {
      const sectionsObj = findNamedObjectProperty(pageOptionsObj, "sections");
      if (!sectionsObj) {
        throw new Error(
          `Page "${options.pageKey}" in cimisy.config.ts doesn't have a \`sections: {...}\` object — refusing to guess its shape.`,
        );
      }
      const collision = sectionsObj.properties.some(
        (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === options.sectionKey,
      );
      if (collision) {
        throw new Error(`Page "${options.pageKey}" already has a section named "${options.sectionKey}".`);
      }
      return insertObjectLiteralProperty(withImports, source, sectionsObj, (indent) => buildSectionSourceText(options, indent));
    }
    assertNoTopLevelNameCollision(configObj, options.pageKey);
    return insertObjectLiteralProperty(withImports, source, pagesObj, (indent) => buildPageWithSectionSourceText(options, indent));
  }

  assertNoTopLevelNameCollision(configObj, options.pageKey);
  return insertObjectLiteralProperty(withImports, source, configObj, (indent) => {
    const inner = `${indent}  `;
    return [`${indent}pages: {`, buildPageWithSectionSourceText(options, inner), `${indent}},`].join("\n");
  });
}
