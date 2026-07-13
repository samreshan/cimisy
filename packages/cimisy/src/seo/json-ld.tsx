import type { JSX } from "react";

/** A schema.org node; "@context" is added by <JsonLd> at render time. */
export type JsonLdObject = { "@type": string; [key: string]: unknown };

function iso(date: string | Date | undefined): string | undefined {
  if (date === undefined) return undefined;
  return date instanceof Date ? date.toISOString() : date;
}

/** Drops undefined properties, then shallow-merges `overrides` last — the hook for CMS-edited additions/replacements. */
function build(base: Record<string, unknown>, overrides?: Record<string, unknown>): JsonLdObject {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return { ...cleaned, ...overrides } as JsonLdObject;
}

export function articleJsonLd(input: {
  headline: string;
  description?: string;
  url?: string;
  image?: string | string[];
  datePublished?: string | Date;
  dateModified?: string | Date;
  authorName?: string;
  publisher?: { name: string; logo?: string };
  /** Shallow-merged last — store schema.org extras in a CMS field and spread them here. */
  overrides?: Record<string, unknown>;
}): JsonLdObject {
  return build(
    {
      "@type": "Article",
      headline: input.headline,
      description: input.description,
      url: input.url,
      image: input.image,
      datePublished: iso(input.datePublished),
      dateModified: iso(input.dateModified),
      author: input.authorName !== undefined ? { "@type": "Person", name: input.authorName } : undefined,
      publisher:
        input.publisher !== undefined
          ? build({
              "@type": "Organization",
              name: input.publisher.name,
              logo: input.publisher.logo !== undefined ? { "@type": "ImageObject", url: input.publisher.logo } : undefined,
            })
          : undefined,
    },
    input.overrides,
  );
}

export function breadcrumbListJsonLd(items: Array<{ name: string; url: string }>): JsonLdObject {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function organizationJsonLd(input: {
  name: string;
  url?: string;
  logo?: string;
  sameAs?: string[];
  overrides?: Record<string, unknown>;
}): JsonLdObject {
  return build(
    { "@type": "Organization", name: input.name, url: input.url, logo: input.logo, sameAs: input.sameAs },
    input.overrides,
  );
}

export function webSiteJsonLd(input: {
  name: string;
  url: string;
  description?: string;
  overrides?: Record<string, unknown>;
}): JsonLdObject {
  return build({ "@type": "WebSite", name: input.name, url: input.url, description: input.description }, input.overrides);
}

/**
 * Serializes for a <script> context, where HTML entities are NOT decoded:
 * a literal "</script>" inside a JSON string would end the script element
 * early and turn the rest of the payload into markup — and CMS-edited
 * strings flow into these objects. Escaping every "<" as < (plus the
 * JS line separators U+2028/U+2029, invalid in some JSON-in-JS contexts)
 * keeps the payload byte-safe while remaining identical JSON.
 */
function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Renders schema.org structured data as <script type="application/ld+json">, XSS-hardened (see serializeJsonLd). Usable from server and client components alike. */
export function JsonLd({ data }: { data: JsonLdObject | JsonLdObject[] }): JSX.Element {
  const withContext = Array.isArray(data)
    ? data.map((d) => ({ "@context": "https://schema.org", ...d }))
    : { "@context": "https://schema.org", ...data };
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(withContext) }} />;
}
