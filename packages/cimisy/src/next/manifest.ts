import type { BlocksFieldDefinition } from "../config/fields/blocks.js";
import type { ImageFieldDefinition } from "../config/fields/image.js";
import type { SeoFieldDefinition } from "../config/fields/seo.js";
import type { TextFieldDefinition } from "../config/fields/text.js";
import type { FieldDefinition } from "../config/fields/types.js";
import type { ResolvedCimisyConfig } from "../config/define-config.js";

export interface BlockTypeManifest {
  /** Registry key — this is the value written into a block node's `type`. */
  name: string;
  kind: string;
  label: string;
  uiOptions?: Record<string, unknown>;
  /** Name of the prop (if any) holding InlineNode[] rich text — see config/fields/blocks.ts's BlockDefinition.richTextProp. */
  richTextProp?: string;
}

export interface FieldManifest {
  name: string;
  kind: string;
  label: string;
  /** Only present for kind === "blocks" — the set of block types the editor can add/render. */
  blockTypes?: BlockTypeManifest[];
  /** Present for kind === "image" (and kind === "seo" when it configures one) — the repo-relative directory uploads through this field must land under (see content/media.ts's assertConfiguredDirectory). */
  directory?: string;
  /** Present for kind === "text" when the field declared validation — drives the admin's required marker, maxLength attribute, and pre-submit checks. The server re-validates regardless (content/validate-values.ts). */
  required?: boolean;
  maxLength?: number;
}

export interface CollectionManifest {
  kind: "collection";
  /** Flat content key — "posts", or "home.testimonials" for page-nested collections. What API routes and admin URLs address. */
  key: string;
  label: string;
  slugField: string;
  fields: FieldManifest[];
  /** Template with a `:slug` placeholder (e.g. "/blog/:slug") — present only when the collection configured one. Drives whether the admin UI shows a "Preview" link. */
  previewPath?: string;
}

export interface SingletonManifest {
  kind: "singleton";
  key: string;
  label: string;
  fields: FieldManifest[];
  /** A fixed route (no `:slug` — a singleton is one page). Sections inherit their page's `route` here. */
  previewPath?: string;
}

export type EntityManifest = CollectionManifest | SingletonManifest;

export type ManifestTreeNode =
  | EntityManifest
  | { kind: "page"; key: string; label: string; route?: string; children: EntityManifest[] };

/**
 * Client-safe projection of CimisyConfig: strips zod schemas, access-rule
 * functions, and the storage adapter — none of which are serializable
 * across the server/client boundary (or safe to hand to the browser).
 * Block registries are similarly stripped down to name/kind/label/
 * uiOptions — never the propsSchema or toMdxNode/matches/extractProps
 * functions.
 *
 * `tree` mirrors the config's page/section hierarchy for navigation, then
 * groups any top-level collection/singleton that has a `previewPath`
 * under a route-labeled group too (merging into a matching declared
 * `page()` group when one exists) — see `groupTopLevelByRoute`. `byKey`
 * is the flat lookup every screen that already has a key (entry form,
 * drafts, preview URLs) uses.
 */
export interface AdminManifest {
  tree: ManifestTreeNode[];
  byKey: Record<string, EntityManifest>;
  /** Whether the storage adapter supports pull requests (see storage/types.ts's capabilities.pullRequests) — drives whether the admin UI shows the Drafts screen at all. */
  draftsSupported: boolean;
}

function buildFieldManifest(fieldName: string, fieldDef: FieldDefinition): FieldManifest {
  const base: FieldManifest = { name: fieldName, kind: fieldDef.kind, label: fieldDef.label };
  if (fieldDef.kind === "text") {
    const validation = (fieldDef as TextFieldDefinition).validation;
    return {
      ...base,
      ...(validation?.isRequired ? { required: true } : {}),
      ...(validation?.maxLength ? { maxLength: validation.maxLength } : {}),
    };
  }
  if (fieldDef.kind === "image") {
    return { ...base, directory: (fieldDef as ImageFieldDefinition).directory };
  }
  if (fieldDef.kind === "seo") {
    // Reuses the image field's `directory` channel so the og-image picker
    // gets the same media allowlist/upload behavior with no extra plumbing.
    return { ...base, directory: (fieldDef as SeoFieldDefinition).imageDirectory };
  }
  if (fieldDef.kind !== "blocks") return base;
  const registry = (fieldDef as BlocksFieldDefinition).registry;
  return {
    ...base,
    blockTypes: Object.entries(registry).map(([name, def]) => ({
      name,
      kind: def.kind,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      uiOptions: def.uiOptions,
      richTextProp: def.richTextProp,
    })),
  };
}

function buildFields(schema: Record<string, FieldDefinition>): FieldManifest[] {
  return Object.entries(schema).map(([fieldName, fieldDef]) => buildFieldManifest(fieldName, fieldDef));
}

/**
 * Resolves the route a top-level entity's previewPath belongs to, for
 * admin-tree grouping purposes only. A singleton's previewPath is already
 * a fixed route. A collection's previewPath is a template with a literal
 * ":slug" marker (e.g. "/blog/:slug", the same marker entry-form.tsx's
 * buildPreviewUrl substitutes into) — stripped to yield the containing
 * route ("/blog"). A previewPath with no ":slug" is already a route and
 * is returned as-is. Returns undefined when there's no previewPath at
 * all — such entities stay flat, unchanged.
 */
function deriveRouteBase(entity: EntityManifest): string | undefined {
  if (!entity.previewPath) return undefined;
  if (entity.kind === "singleton") return entity.previewPath;
  const slugIndex = entity.previewPath.indexOf(":slug");
  if (slugIndex === -1) return entity.previewPath;
  const base = entity.previewPath.slice(0, slugIndex).replace(/\/+$/, "");
  return base === "" ? "/" : base;
}

/** e.g. "/blog" -> "Blog", "/" -> "Home". */
function deriveSyntheticGroupLabel(routeBase: string): string {
  const segments = routeBase.split("/").filter(Boolean);
  if (segments.length === 0) return "Home";
  const last = segments[segments.length - 1]!;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/**
 * Second pass over the tree: pulls top-level collections/singletons with
 * a resolved previewPath route out of the flat list and groups them by
 * route — merging into a matching declared page() group when one exists
 * (dedupe by route, no duplicate group), else synthesizing a new
 * page-shaped group node at the position of its first contributing item.
 * Declared page() groups and previewPath-less top-level entities are left
 * exactly as pass one built them. Declarative only — routes come from
 * previewPath already on the manifest, never from filesystem/App Router
 * scanning.
 */
function groupTopLevelByRoute(tree: ManifestTreeNode[]): ManifestTreeNode[] {
  const pageGroupByRoute = new Map<string, Extract<ManifestTreeNode, { kind: "page" }>>();
  for (const node of tree) {
    if (node.kind === "page" && node.route) pageGroupByRoute.set(node.route, node);
  }

  const syntheticGroupByRoute = new Map<string, Extract<ManifestTreeNode, { kind: "page" }>>();
  const result: ManifestTreeNode[] = [];

  for (const node of tree) {
    if (node.kind === "page") {
      result.push(node);
      continue;
    }
    const routeBase = deriveRouteBase(node);
    if (!routeBase) {
      result.push(node);
      continue;
    }
    const declaredGroup = pageGroupByRoute.get(routeBase);
    if (declaredGroup) {
      declaredGroup.children.push(node);
      continue;
    }
    const existingSynthetic = syntheticGroupByRoute.get(routeBase);
    if (existingSynthetic) {
      existingSynthetic.children.push(node);
      continue;
    }
    const syntheticGroup: Extract<ManifestTreeNode, { kind: "page" }> = {
      kind: "page",
      key: `__route:${routeBase}`,
      label: deriveSyntheticGroupLabel(routeBase),
      route: routeBase,
      children: [node],
    };
    syntheticGroupByRoute.set(routeBase, syntheticGroup);
    result.push(syntheticGroup);
  }

  return result;
}

export function buildAdminManifest(cimisyConfig: ResolvedCimisyConfig): AdminManifest {
  const byKey: Record<string, EntityManifest> = {};

  function entityFor(kind: "collection" | "singleton", key: string): EntityManifest {
    if (kind === "collection") {
      const def = cimisyConfig.collectionsByKey[key]!;
      const manifest: CollectionManifest = {
        kind: "collection",
        key,
        label: def.label,
        slugField: def.slugField,
        previewPath: def.previewPath,
        fields: buildFields(def.schema),
      };
      byKey[key] = manifest;
      return manifest;
    }
    const def = cimisyConfig.singletonsByKey[key]!;
    const manifest: SingletonManifest = {
      kind: "singleton",
      key,
      label: def.label,
      previewPath: def.previewPath,
      fields: buildFields(def.schema),
    };
    byKey[key] = manifest;
    return manifest;
  }

  const tree: ManifestTreeNode[] = cimisyConfig.contentTree.map((node) => {
    if (node.kind === "page") {
      return {
        kind: "page" as const,
        key: node.key,
        label: node.label,
        route: node.route,
        children: node.children
          .filter((child): child is typeof child & { kind: "collection" | "singleton" } => child.kind !== "page")
          .map((child) => entityFor(child.kind, child.key)),
      };
    }
    return entityFor(node.kind, node.key);
  });

  return { tree: groupTopLevelByRoute(tree), byKey, draftsSupported: cimisyConfig.source.capabilities.pullRequests };
}
