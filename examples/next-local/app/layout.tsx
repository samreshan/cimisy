import type { ReactNode } from "react";

export const metadata = {
  title: "cimisy — next-local example",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "2rem auto", padding: "0 1rem" }}>
        {children}
        {/* Deliberately hardcoded: `cimisy scan --mode=static` should propose this
            layout-owned region as a top-level singleton spanning every route. */}
        <footer id="site-footer" style={{ marginTop: "4rem", borderTop: "1px solid #ddd", paddingTop: "1rem" }}>
          <h2>cimisy example</h2>
          <p>A git-based CMS that moves into your repo. This footer renders on every page via the root layout.</p>
        </footer>
      </body>
    </html>
  );
}
