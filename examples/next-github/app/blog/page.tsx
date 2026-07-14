import { createReader } from "cimisy/next";
import Link from "next/link";
import cimisyConfig from "@/cimisy.config";

const reader = createReader(cimisyConfig);

export default async function BlogIndexPage() {
  const posts = (await reader.collections.posts?.all()) ?? [];

  return (
    <main>
      <p>
        <Link href="/">&larr; Home</Link>
      </p>
      <h1>Blog</h1>
      {posts.length === 0 ? (
        <p>No posts yet.</p>
      ) : (
        <ul>
          {posts.map((post) => (
            <li key={post.slug}>
              <Link href={`/blog/${post.slug}`}>{post.error ? `${post.slug} (failed to parse)` : String(post.values.title)}</Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
