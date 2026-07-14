import { createReader } from "cimisy/next";
import { renderBlocks, type BlockNodeLike } from "cimisy/render";
import { articleJsonLd, createMetadata, JsonLd, seoDefaultsFromSettings, type SeoValue } from "cimisy/seo";
import type { Metadata } from "next";
import { draftMode } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
import cimisyConfig from "@/cimisy.config";

const reader = createReader(cimisyConfig);

/**
 * SEO: the entry's fields.seo() value (edited in the admin's SEO panel)
 * layered over the entry's own title, layered over the site-wide defaults
 * from the settings singleton — all via one createMetadata call.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const [post, settings] = await Promise.all([
    reader.collections.posts?.bySlug(slug),
    reader.singletons.settings?.get(),
  ]);
  if (!post || post.error) return {};
  return createMetadata({
    seo: post.values.seo as SeoValue | undefined,
    fallback: {
      title: typeof post.values.title === "string" ? post.values.title : undefined,
      image: typeof post.values.coverImage === "string" ? post.values.coverImage : undefined,
    },
    defaults: seoDefaultsFromSettings(settings?.values),
    path: `/blog/${slug}`,
  });
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [post, settings] = await Promise.all([
    reader.collections.posts?.bySlug(slug),
    reader.singletons.settings?.get(),
  ]);
  if (!post || post.error) notFound();

  const { isEnabled: previewing } = await draftMode();
  const body = Array.isArray(post.values.body) ? (post.values.body as BlockNodeLike[]) : [];
  const siteName = typeof settings?.values.siteName === "string" ? settings.values.siteName : undefined;

  return (
    <main>
      <JsonLd
        data={articleJsonLd({
          headline: String(post.values.title),
          url: `/blog/${slug}`,
          datePublished: typeof post.values.publishedAt === "string" ? post.values.publishedAt : undefined,
          image: typeof post.values.coverImage === "string" ? post.values.coverImage : undefined,
          publisher: siteName ? { name: siteName } : undefined,
        })}
      />
      {previewing && (
        <p style={{ background: "#fff3cd", padding: 8, borderRadius: 4 }}>
          Previewing a draft —{" "}
          {/* prefetch=false: this is a state-changing GET (disables draft mode), not a page — must not fire until clicked */}
          <Link href="/api/cimisy/preview/disable?redirectTo=/blog" prefetch={false}>
            exit preview
          </Link>
        </p>
      )}
      <p>
        <Link href="/blog">&larr; All posts</Link>
      </p>
      <h1>{String(post.values.title)}</h1>
      {renderBlocks(body)}
    </main>
  );
}
