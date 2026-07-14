import { createReader } from "cimisy/next";
import { renderBlocks, type BlockNodeLike } from "cimisy/render";
import { draftMode } from "next/headers";
import { notFound } from "next/navigation";
import Link from "next/link";
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
