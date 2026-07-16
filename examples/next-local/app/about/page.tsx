/**
 * Deliberately hardcoded page: `cimisy scan --mode=static-metadata` should
 * propose (a) this metadata as an importable pages.about.seo candidate and
 * (b) the hero region as a pages.about section — dogfooding the v2.3
 * whole-site scan + metadata import against a real app.
 */
export const metadata = {
  title: "About — cimisy example",
  description: "What this example app demonstrates and why the content on this page is hardcoded on purpose.",
  openGraph: { url: "/about" },
};

export default function AboutPage() {
  return (
    <main>
      <section id="about-hero">
        <h1>About this example</h1>
        <p>
          Everything on this page is intentionally hardcoded so the scanner has something real to find. Run the scan
          from this directory and import the candidates to watch them move into cimisy.
        </p>
      </section>
    </main>
  );
}
