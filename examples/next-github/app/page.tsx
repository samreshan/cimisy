import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>cimisy — next-github example</h1>
      <p>
        This app demonstrates cimisy&apos;s GitHub-backed storage adapter, GitHub App
        authentication, layered RBAC with a branch/PR draft workflow, the block editor, and the
        public Reader API + Draft Mode preview.
      </p>
      <p>Requires a GitHub App to be registered and installed first — see this app&apos;s README.</p>
      <p>
        <Link href="/admin">Open the admin panel &rarr;</Link>
      </p>
      <p>
        <Link href="/blog">View the public blog &rarr;</Link>
      </p>
    </main>
  );
}
