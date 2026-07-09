import { createReader } from "cimisy/next";
import cimisyConfig from "@/cimisy.config";

const reader = createReader(cimisyConfig);

export default async function BlogIndexPage() {
  const posts = (await reader.collections.posts?.all()) ?? [];

  return (
    <main>
      <p>
        <a href="/">&larr; Home</a>
      </p>
      <h1>Blog</h1>
      {posts.length === 0 ? (
        <p>No posts yet.</p>
      ) : (
        <ul>
          {posts.map((post) => (
            <li key={post.slug}>
              <a href={`/blog/${post.slug}`}>{post.error ? `${post.slug} (failed to parse)` : String(post.values.title)}</a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
