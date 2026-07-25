import type { CSSProperties } from "react";
import { AUTH_CALLBACK_PATH } from "../shared/auth-callback-path.js";

/**
 * What `/admin` renders on a deployment whose GitHub variables were never
 * set (see storage/unconfigured.ts).
 *
 * This is a README rendered in place, not a setup UI: no inputs, no
 * client JavaScript, no state, nothing that accepts or stores a
 * credential. That's deliberate — the project decided against an in-admin
 * credential wizard, and adding one here through the back door would put
 * a "paste your App private key" form on an unauthenticated public URL.
 *
 * It is unauthenticated by necessity (there's no source to resolve a
 * session against), so it may only ever show things that aren't secret:
 * variable *names*, the callback URL for this origin, and the command to
 * run. Never a value, never a stack trace.
 */

export interface CimisyUnconfiguredPageProps {
  /** Canonical env var names that are missing. Names only. */
  missing: readonly string[];
  /** Where the admin is mounted, e.g. "/admin" — used to explain the callback URL. */
  basePath?: string;
}

/**
 * Best-effort origin of the current request, so the page can print the
 * exact callback URL to register rather than a `<your-url>` placeholder —
 * getting that URL subtly wrong is one of the setup's classic failures.
 * Imported dynamically and guarded: `next/headers` throws outside a
 * request scope, and this page must never be the reason a build fails.
 */
async function currentOrigin(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const requestHeaders = await headers();
    const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
    if (!host) return null;
    const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    return `${protocol}://${host}`;
  } catch {
    return null;
  }
}

const page: CSSProperties = {
  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  lineHeight: 1.6,
  color: "#0f172a",
  background: "#f8fafc",
  minHeight: "100vh",
  padding: "3rem 1.5rem",
};
const card: CSSProperties = {
  maxWidth: "44rem",
  margin: "0 auto",
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: "0.75rem",
  padding: "2rem",
};
const code: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.9em",
  background: "#f1f5f9",
  borderRadius: "0.25rem",
  padding: "0.1rem 0.35rem",
};
const block: CSSProperties = { ...code, display: "block", padding: "0.75rem 1rem", overflowX: "auto", whiteSpace: "pre" };

export async function CimisyUnconfiguredPage({ missing }: CimisyUnconfiguredPageProps) {
  const origin = await currentOrigin();
  const callbackUrl = origin ? `${origin}${AUTH_CALLBACK_PATH}` : `<your-deployment-url>${AUTH_CALLBACK_PATH}`;

  return (
    <main style={page}>
      <div style={card}>
        <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.5rem" }}>cimisy is not configured</h1>
        <p style={{ margin: "0 0 1.5rem", color: "#475569" }}>
          This deployment is set up to use the GitHub source, but the credentials it needs aren&rsquo;t in its
          environment. The admin UI stays offline until they are — no content can be read or written.
        </p>

        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Missing environment variables</h2>
        <ul style={{ margin: "0 0 1.5rem", paddingLeft: "1.25rem" }}>
          {missing.map((name) => (
            <li key={name}>
              <span style={code}>{name}</span>
            </li>
          ))}
        </ul>

        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>How to fix it</h2>
        <ol style={{ margin: "0 0 1.5rem", paddingLeft: "1.25rem" }}>
          <li>
            On your own machine, in the project repo, run{" "}
            <span style={code}>npx cimisy setup github</span>. It registers a GitHub App, installs it, and prints one
            variable.
          </li>
          <li>
            Set that variable — <span style={code}>CIMISY_CONFIG</span> — in this deployment&rsquo;s environment
            settings. It carries every value listed above, so it&rsquo;s the only one you need.
          </li>
          <li>Redeploy. Environment variables only take effect on a new build.</li>
        </ol>

        <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>This deployment&rsquo;s callback URL</h2>
        <p style={{ margin: "0 0 0.5rem", color: "#475569" }}>
          The GitHub App must list this exact URL under its callback URLs, or sign-in will fail:
        </p>
        <span style={block}>{callbackUrl}</span>

        <p style={{ margin: "1.5rem 0 0", color: "#475569" }}>
          To check a configuration from your terminal, run <span style={code}>npx cimisy doctor</span>.
        </p>
      </div>
    </main>
  );
}
