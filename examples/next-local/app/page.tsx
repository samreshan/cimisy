import { createReader, type CollectionReader, type SingletonReader } from "cimisy/next";
import cimisyConfig from "@/cimisy.config";

const reader = createReader(cimisyConfig);

/**
 * The home page renders CMS-managed page content: a static hero section
 * (reader.pages.home.hero — one YAML file) and a repeating testimonials
 * collection (reader.pages.home.testimonials). Both are editable in the
 * admin under Pages → Home.
 */
export default async function HomePage() {
  const hero = await (reader.pages.home?.hero as SingletonReader | undefined)?.get();
  const testimonials = (await (reader.pages.home?.testimonials as CollectionReader | undefined)?.all()) ?? [];

  return (
    <main>
      <h1>{String(hero?.values.heading ?? "cimisy — next-local example")}</h1>
      <p>
        {String(
          hero?.values.tagline ??
            "This app demonstrates cimisy's local-adapter flow: config engine, admin UI, block editor, and the public Reader API + Draft Mode preview. Edit this hero under Admin → Home → Hero.",
        )}
      </p>
      <p>
        <a href="/admin">Open the admin panel &rarr;</a>
      </p>
      <p>
        <a href="/blog">View the public blog &rarr;</a>
      </p>
      {testimonials.length > 0 && (
        <section>
          <h2>What people say</h2>
          {testimonials.map(
            (t) =>
              !t.error && (
                <blockquote key={t.slug}>
                  {String(t.values.quote)}
                  {t.values.author ? <footer>— {String(t.values.author)}</footer> : null}
                </blockquote>
              ),
          )}
        </section>
      )}
    </main>
  );
}
