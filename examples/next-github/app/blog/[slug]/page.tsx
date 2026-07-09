import { createReader } from "cimisy/next";
import { renderBlocks, type BlockNodeLike } from "cimisy/render";
import { draftMode } from "next/headers";
import { notFound } from "next/navigation";
import cimisyConfig from "@/cimisy.config";

const reader = createReader(cimisyConfig);

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await reader.collections.posts?.bySlug(slug);
  if (!post || post.error) notFound();

  const { isEnabled: previewing } = await draftMode();
  const body = Array.isArray(post.values.body) ? (post.values.body as BlockNodeLike[]) : [];

  return (
    <main>
      {previewing && (
        <p style={{ background: "#fff3cd", padding: 8, borderRadius: 4 }}>
          Previewing a draft — <a href="/api/cimisy/preview/disable?redirectTo=/blog">exit preview</a>
        </p>
      )}
      <p>
        <a href="/blog">&larr; All posts</a>
      </p>
      <h1>{String(post.values.title)}</h1>
      {renderBlocks(body)}
    </main>
  );
}
