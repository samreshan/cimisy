import { fields } from "../config/fields/index.js";
import type { FieldDefinition } from "../config/fields/types.js";
import type { ImageFieldDefinition } from "../config/fields/image.js";
import type { SeoDefaults } from "./metadata.js";

/**
 * Schema factory for the conventional site-settings singleton — spread it
 * into a singleton's schema (adding your own fields alongside is fine):
 *
 *   singletons: {
 *     settings: singleton({
 *       label: "Site settings",
 *       path: "content/settings.yaml",
 *       schema: { ...seoSettingsFields({ imageDirectory: "public/uploads" }) },
 *     }),
 *   }
 *
 * Deliberately no magic lookup by singleton key anywhere in cimisy — the
 * site passes the loaded values through seoDefaultsFromSettings()
 * explicitly, keeping the seo module free of storage coupling.
 */
export function seoSettingsFields(options: { imageDirectory?: string } = {}): {
  siteName: FieldDefinition<string>;
  titleTemplate: FieldDefinition<string>;
  description: FieldDefinition<string>;
  siteUrl: FieldDefinition<string>;
  ogImage: ImageFieldDefinition | FieldDefinition<string>;
  twitterHandle: FieldDefinition<string>;
} {
  return {
    siteName: fields.text({ label: "Site name" }),
    titleTemplate: fields.text({ label: "Title template (use %s for the page title)" }),
    description: fields.text({ label: "Default description" }),
    siteUrl: fields.text({ label: "Site URL (https://…)" }),
    ogImage: options.imageDirectory
      ? fields.image({ label: "Default social image", directory: options.imageDirectory })
      : fields.text({ label: "Default social image (path or URL)" }),
    twitterHandle: fields.text({ label: "Twitter handle (@…)" }),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Converts a loaded settings singleton's values (or undefined, if never saved) into the SeoDefaults createMetadata expects. Unknown/empty fields simply drop out. */
export function seoDefaultsFromSettings(values: Record<string, unknown> | undefined): SeoDefaults {
  if (!values) return {};
  return {
    siteName: nonEmptyString(values["siteName"]),
    titleTemplate: nonEmptyString(values["titleTemplate"]),
    description: nonEmptyString(values["description"]),
    siteUrl: nonEmptyString(values["siteUrl"]),
    ogImage: nonEmptyString(values["ogImage"]),
    twitterHandle: nonEmptyString(values["twitterHandle"]),
  };
}
