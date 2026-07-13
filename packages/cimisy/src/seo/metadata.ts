import type { Metadata } from "next";
import type { SeoValue } from "../config/fields/seo.js";

/**
 * Site-wide defaults an entry's own SEO value is layered over — typically
 * sourced from the conventional site-settings singleton via
 * seoDefaultsFromSettings() (see settings.ts), but a plain literal works
 * too. Pure data: this module deliberately has no storage or server
 * coupling (and no `server-only`), so it's usable from any context.
 */
export interface SeoDefaults {
  siteName?: string;
  /** e.g. "%s — Acme"; %s is replaced with the resolved page title. Not applied when the page has no title of its own. */
  titleTemplate?: string;
  description?: string;
  /** Absolute origin (e.g. "https://example.com") used to resolve canonical/og:url and og:image paths to absolute URLs. */
  siteUrl?: string;
  /** Site-wide fallback og:image (path or absolute URL). */
  ogImage?: string;
  /** e.g. "@acme" — emitted as twitter:site. */
  twitterHandle?: string;
}

function absoluteUrl(pathOrUrl: string, siteUrl?: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  if (!siteUrl) return pathOrUrl;
  return `${siteUrl.replace(/\/$/, "")}/${pathOrUrl.replace(/^\//, "")}`;
}

function applyTitleTemplate(title: string, template?: string): string {
  if (!template || !template.includes("%s")) return title;
  return template.replace("%s", title);
}

/**
 * Low-level converter: one stored SeoValue (+ site defaults) → a Next.js
 * Metadata object. Most pages want createMetadata() below, which also
 * layers in per-entry fallbacks (the entry's own title/description).
 */
export function toNextMetadata(seo: SeoValue | null | undefined, defaults: SeoDefaults = {}): Metadata {
  return createMetadata({ seo, defaults });
}

export interface CreateMetadataInput {
  /** The entry/page's stored fields.seo() value. */
  seo?: SeoValue | null;
  /** Per-entry fallbacks when the SEO panel was left (partly) empty — typically the entry's own title/description/cover image. */
  fallback?: { title?: string; description?: string; image?: string };
  /** Site-wide defaults, usually seoDefaultsFromSettings(settings.values). */
  defaults?: SeoDefaults;
  /** The page's route (e.g. `/blog/${slug}`) — used as the canonical when the SEO value doesn't set one explicitly. */
  path?: string;
}

/**
 * The one-line `generateMetadata` helper: resolves each metadata facet
 * with the precedence entry SEO value > entry fallback > site defaults,
 * and emits title/description, alternates.canonical, Open Graph, Twitter,
 * and robots (from `noindex`) in Next.js Metadata shape.
 */
export function createMetadata(input: CreateMetadataInput): Metadata {
  const seo = input.seo ?? {};
  const defaults = input.defaults ?? {};
  const fallback = input.fallback ?? {};

  const rawTitle = seo.title ?? fallback.title;
  const title = rawTitle !== undefined ? applyTitleTemplate(rawTitle, defaults.titleTemplate) : undefined;
  const description = seo.description ?? fallback.description ?? defaults.description;
  const canonicalSource = seo.canonical ?? input.path;
  const canonical = canonicalSource !== undefined ? absoluteUrl(canonicalSource, defaults.siteUrl) : undefined;
  const imageSource = seo.ogImage ?? fallback.image ?? defaults.ogImage;
  const image = imageSource != null ? absoluteUrl(imageSource, defaults.siteUrl) : undefined;

  const metadata: Metadata = {};
  if (title !== undefined) metadata.title = title;
  if (description !== undefined) metadata.description = description;
  if (canonical !== undefined) metadata.alternates = { canonical };
  if (seo.noindex) metadata.robots = { index: false, follow: false };

  const openGraph: NonNullable<Metadata["openGraph"]> = {};
  if (title !== undefined) openGraph.title = title;
  if (description !== undefined) openGraph.description = description;
  if (canonical !== undefined) openGraph.url = canonical;
  if (defaults.siteName !== undefined) openGraph.siteName = defaults.siteName;
  if (image !== undefined) openGraph.images = [{ url: image }];
  if (Object.keys(openGraph).length > 0) metadata.openGraph = openGraph;

  const twitter: NonNullable<Metadata["twitter"]> = { card: image !== undefined ? "summary_large_image" : "summary" };
  if (title !== undefined) twitter.title = title;
  if (description !== undefined) twitter.description = description;
  if (image !== undefined) twitter.images = [image];
  if (defaults.twitterHandle !== undefined) twitter.site = defaults.twitterHandle;
  metadata.twitter = twitter;

  return metadata;
}
