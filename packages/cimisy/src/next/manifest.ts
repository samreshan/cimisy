import type { BlocksFieldDefinition } from "../config/fields/blocks.js";
import type { ImageFieldDefinition } from "../config/fields/image.js";
import type { CimisyConfig } from "../config/define-config.js";

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
  /** Only present for kind === "image" — the repo-relative directory uploads through this field must land under (see content/media.ts's assertConfiguredDirectory). */
  directory?: string;
}

export interface CollectionManifest {
  name: string;
  label: string;
  slugField: string;
  fields: FieldManifest[];
  /** Template with a `:slug` placeholder (e.g. "/blog/:slug") — present only when the collection configured one. Drives whether the admin UI shows a "Preview" link. */
  previewPath?: string;
}

/**
 * Client-safe projection of CimisyConfig: strips zod schemas, access-rule
 * functions, and the storage adapter — none of which are serializable
 * across the server/client boundary (or safe to hand to the browser).
 * Block registries are similarly stripped down to name/kind/label/
 * uiOptions — never the propsSchema or toMdxNode/matches/extractProps
 * functions.
 */
export interface AdminManifest {
  collections: CollectionManifest[];
  /** Whether the storage adapter supports pull requests (see storage/types.ts's capabilities.pullRequests) — drives whether the admin UI shows the Drafts screen at all. */
  draftsSupported: boolean;
}

function buildFieldManifest(fieldName: string, fieldDef: CimisyConfig["collections"][string]["schema"][string]): FieldManifest {
  const base: FieldManifest = { name: fieldName, kind: fieldDef.kind, label: fieldDef.label };
  if (fieldDef.kind === "image") {
    return { ...base, directory: (fieldDef as ImageFieldDefinition).directory };
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

export function buildAdminManifest(cimisyConfig: CimisyConfig): AdminManifest {
  return {
    collections: Object.entries(cimisyConfig.collections).map(([name, def]) => ({
      name,
      label: def.label,
      slugField: def.slugField,
      previewPath: def.previewPath,
      fields: Object.entries(def.schema).map(([fieldName, fieldDef]) => buildFieldManifest(fieldName, fieldDef)),
    })),
    draftsSupported: cimisyConfig.source.capabilities.pullRequests,
  };
}
