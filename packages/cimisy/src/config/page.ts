import type { CollectionDefinition } from "./collection.js";
import type { SectionDefinition } from "./section.js";

export interface PageOptions {
  label: string;
  /**
   * Content directory for this page's sections/collections, e.g.
   * "content/pages/home". Defaults to "content/pages/<key>", where <key>
   * is the page's key in config({ pages }). Validated during config()
   * normalization (same charset rules as collection paths).
   */
  path?: string;
  /**
   * Where the page renders on the public site (e.g. "/" or "/about").
   * When set, sections of this page inherit it as their admin Preview
   * link; when omitted, sections have no preview link.
   */
  route?: string;
  /**
   * Named children: section() for static one-file content, collection()
   * for repeating entries. A nested collection may omit its `path` — the
   * normalizer derives "<pagePath>/<key>/*.mdx".
   */
  sections: Record<string, SectionDefinition | CollectionDefinition>;
}

export interface PageDefinition {
  readonly type: "page";
  readonly label: string;
  readonly path?: string;
  readonly route?: string;
  readonly sections: Record<string, SectionDefinition | CollectionDefinition>;
}

/**
 * A page groups the content that renders on one route of the site —
 * static sections and repeating collections — so the admin UI can mirror
 * how the site is actually structured (page → section → contents) instead
 * of one flat list. Deliberately one level deep (no page-in-page); the
 * flat dotted-key addressing scheme (see define-config.ts) already
 * accommodates deeper nesting later without another breaking change.
 */
export function page(options: PageOptions): PageDefinition {
  if (Object.keys(options.sections).length === 0) {
    throw new Error(`Page "${options.label}" must declare at least one section or collection.`);
  }
  return {
    type: "page",
    label: options.label,
    path: options.path,
    route: options.route,
    sections: options.sections,
  };
}
