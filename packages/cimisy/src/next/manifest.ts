import type { BlocksFieldDefinition } from "../config/fields/blocks.js";
import type { ImageFieldDefinition } from "../config/fields/image.js";
import type { SeoFieldDefinition } from "../config/fields/seo.js";
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
 * `tree` mirrors the config's page/section hierarchy for navigation;
 * `byKey` is the flat lookup every screen that already has a key (entry
 * form, drafts, preview URLs) uses.
 */
export interface AdminManifest {
  tree: ManifestTreeNode[];
  byKey: Record<string, EntityManifest>;
  /** Whether the storage adapter supports pull requests (see storage/types.ts's capabilities.pullRequests) — drives whether the admin UI shows the Drafts screen at all. */
  draftsSupported: boolean;
}

function buildFieldManifest(fieldName: string, fieldDef: FieldDefinition): FieldManifest {
  const base: FieldManifest = { name: fieldName, kind: fieldDef.kind, label: fieldDef.label };
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

  return { tree, byKey, draftsSupported: cimisyConfig.source.capabilities.pullRequests };
}
