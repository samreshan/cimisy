import type { ArrayFieldDefinition } from "../config/fields/array.js";
import type { BlocksFieldDefinition } from "../config/fields/blocks.js";
import type { ImageFieldDefinition } from "../config/fields/image.js";
import type { NumberFieldDefinition } from "../config/fields/number.js";
import type { SelectFieldDefinition } from "../config/fields/select.js";
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
  /** Present for kind === "text"/"number"/"select" when the field declared validation — drives the admin's required marker, maxLength attribute, and pre-submit checks. The server re-validates regardless (content/validate-values.ts). */
  required?: boolean;
  maxLength?: number;
  /** kind === "text" only: render as a textarea. */
  multiline?: boolean;
  /** kind === "select" only: the allowed values, in display order. */
  options?: string[];
  /** kind === "number" only. */
  min?: number;
  max?: number;
  /** kind === "array" only: the wrapped item field (its own manifest, so per-item inputs render by kind). */
  item?: FieldManifest;
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
  /** Whether the dev-only scan/import screen is available — local adapter outside production only, mirroring route-handler.ts's scanSurfaceAvailable gate. Never true on a deployed server. */
  scanSupported: boolean;
}

function buildFieldManifest(fieldName: string, fieldDef: FieldDefinition): FieldManifest {
  const base: FieldManifest = { name: fieldName, kind: fieldDef.kind, label: fieldDef.label };
  if (fieldDef.kind === "text") {
    const textDef = fieldDef as TextFieldDefinition;
    return {
      ...base,
      ...(textDef.multiline ? { multiline: true } : {}),
      ...(textDef.validation?.isRequired ? { required: true } : {}),
      ...(textDef.validation?.maxLength ? { maxLength: textDef.validation.maxLength } : {}),
    };
  }
  if (fieldDef.kind === "number") {
    const validation = (fieldDef as NumberFieldDefinition).validation;
    return {
      ...base,
      ...(validation?.isRequired ? { required: true } : {}),
      ...(validation?.min !== undefined ? { min: validation.min } : {}),
      ...(validation?.max !== undefined ? { max: validation.max } : {}),
    };
  }
  if (fieldDef.kind === "select") {
    const selectDef = fieldDef as SelectFieldDefinition;
    return {
      ...base,
      options: selectDef.options,
      ...(selectDef.validation?.isRequired ? { required: true } : {}),
    };
  }
  if (fieldDef.kind === "array") {
    const itemField = (fieldDef as ArrayFieldDefinition).itemField;
    // Pre-2.4 array definitions (from a stale built config) may lack itemField — fall back to a text item, the only shape they could have had.
    return { ...base, item: itemField ? buildFieldManifest(`${fieldName}-item`, itemField) : { name: `${fieldName}-item`, kind: "text", label: base.label } };
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

  return {
    tree: groupTopLevelByRoute(tree),
    byKey,
    draftsSupported: cimisyConfig.source.capabilities.pullRequests,
    // Server-computed (this runs in CimisyAdminPage, a server component), so
    // the client can't decide for itself that scanning is available — and the
    // API routes re-check the same condition regardless (route-handler.ts).
    scanSupported: cimisyConfig.source.kind === "local" && process.env.NODE_ENV !== "production",
  };
}
