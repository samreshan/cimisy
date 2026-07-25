import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GithubAppManifest } from "./manifest.js";

/**
 * The browser round trip of the App Manifest flow, and the credential
 * exchange that ends it.
 *
 * Trust boundary note (see THREAT_MODEL.md): for a few seconds this
 * process runs an HTTP server that will receive, from a browser, a
 * single-use code redeemable for a GitHub App's private key and client
 * secret. Everything below exists to keep that window as small and as
 * unaddressable as possible — bound to the loopback interface only,
 * unguessable state parameter compared in constant time, exactly one
 * callback accepted, shut down the instant it fires, and a hard timeout so
 * an abandoned run doesn't leave a listener alive. The code and the
 * credentials it yields are never logged.
 */

/** GitHub expires a manifest code after 1 hour; the wizard's own window is far shorter than that on purpose. */
export const DEFAULT_MANIFEST_TIMEOUT_MS = 10 * 60 * 1000;

const CALLBACK_PATH = "/callback";

export interface ManifestCallbackServer {
  /** Open this in a browser — it serves the auto-submitting manifest form. */
  startUrl: string;
  /** Resolves with the one-time manifest code, or rejects on state mismatch/timeout/abort. */
  code: Promise<string>;
  /** Idempotent; safe to call after the promise settles. */
  close(): Promise<void>;
}

export interface StartManifestCallbackServerOptions {
  /** Where the form POSTs — see manifestRegistrationUrl. */
  registrationUrl: string;
  /** Called once the ephemeral port is known, since redirect_url must contain it. */
  buildManifest: (redirectUrl: string) => GithubAppManifest;
  /** Defaults to DEFAULT_MANIFEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to 32 random bytes, base64url. */
  state?: string;
}

/** Unguessable, and long enough that a same-machine process can't feasibly race a guess into the callback. */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time comparison. A length check has to come first (timingSafeEqual
 * throws on a length mismatch), which does leak the length of the expected
 * state — harmless, since that length is a fixed constant of this code, not
 * a secret.
 */
export function statesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * GitHub's manifest flow takes the manifest as a form POST, not a query
 * parameter — the JSON is far too long for a URL. So the wizard serves a
 * one-page form and lets the browser submit it, which is also what puts
 * the user on github.com with their existing session rather than asking
 * them to authenticate to anything new.
 */
export function renderManifestFormPage(options: { registrationUrl: string; manifest: GithubAppManifest; state: string }): string {
  const action = `${options.registrationUrl}?state=${encodeURIComponent(options.state)}`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>cimisy setup — redirecting to GitHub</title>',
    "<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;color:#0f172a}main{text-align:center;max-width:32rem;padding:2rem}</style>",
    "</head><body><main>",
    "<h1>Redirecting to GitHub…</h1>",
    "<p>Review the pre-filled GitHub App and confirm it. If nothing happens, use the button below.</p>",
    `<form method="post" action="${escapeHtmlAttribute(action)}">`,
    `<input type="hidden" name="manifest" value="${escapeHtmlAttribute(JSON.stringify(options.manifest))}">`,
    '<button type="submit">Continue to GitHub</button>',
    "</form>",
    "<script>document.forms[0].submit()</script>",
    "</main></body></html>",
  ].join("\n");
}

function renderDonePage(): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>cimisy setup — done here</title>',
    "<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;color:#0f172a}main{text-align:center;max-width:32rem;padding:2rem}</style>",
    "</head><body><main><h1>GitHub App created</h1><p>You can close this tab and return to your terminal.</p></main></body></html>",
  ].join("\n");
}

export async function startManifestCallbackServer(options: StartManifestCallbackServerOptions): Promise<ManifestCallbackServer> {
  const state = options.state ?? generateState();
  const timeoutMs = options.timeoutMs ?? DEFAULT_MANIFEST_TIMEOUT_MS;

  // Definite-assignment asserted: a Promise executor runs synchronously, so
  // this is assigned before the constructor returns.
  let settle!: { resolve: (code: string) => void; reject: (err: Error) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The promise is settled from request handlers that run before any
  // caller attaches a .catch(); without this, a state-mismatch rejection
  // would surface as an unhandled rejection and take the process down.
  code.catch(() => {});

  let settled = false;
  // Assigned only after the listener is bound, but close() (defined below,
  // and called from the timeout itself) has to be able to clear it.
  let timer: NodeJS.Timeout | undefined = undefined;
  // Only knowable once the ephemeral port is assigned, but the form handler
  // (which can't run before listen() resolves) needs it in the manifest.
  let redirectUrl = "";

  const server: Server = createServer((req, res) => {
    // Host is irrelevant — the socket is loopback-bound — but URL parsing needs a base.
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderManifestFormPage({ registrationUrl: options.registrationUrl, manifest: options.buildManifest(redirectUrl), state }));
      return;
    }

    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    // Single-use: a replayed or duplicated callback is refused outright
    // rather than re-running the exchange with a stale code.
    if (settled) {
      res.writeHead(410, { "content-type": "text/plain; charset=utf-8" });
      res.end("This setup callback has already been used. Re-run `npx cimisy setup github` to start over.");
      return;
    }

    const receivedState = url.searchParams.get("state") ?? "";
    const receivedCode = url.searchParams.get("code") ?? "";

    if (!statesMatch(state, receivedState)) {
      settled = true;
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("State mismatch — this request did not come from the setup run that started in your terminal.");
      settle.reject(new Error("Manifest callback state did not match — refusing to redeem the code. Re-run `npx cimisy setup github`."));
      return;
    }
    if (!receivedCode) {
      settled = true;
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("GitHub did not send a code.");
      settle.reject(new Error("GitHub redirected back without a manifest code. Re-run `npx cimisy setup github`."));
      return;
    }

    settled = true;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderDonePage());
    settle.resolve(receivedCode);
  });

  // Loopback only. Binding 0.0.0.0 would expose the manifest code's
  // landing spot to the local network for the life of the wizard.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  redirectUrl = `${origin}${CALLBACK_PATH}`;

  const close = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    settle.reject(new Error(`Timed out after ${Math.round(timeoutMs / 60000)} minutes waiting for GitHub to redirect back. Nothing was created or written.`));
    void close();
  }, timeoutMs);
  // Don't hold the event loop open on the timeout alone.
  timer.unref?.();

  // Shut the listener the moment the code lands (or fails) rather than
  // waiting for the caller to remember to.
  void code.then(
    () => void close(),
    () => void close(),
  );

  return { startUrl: `${origin}/`, code, close };
}

export interface ManifestConversion {
  id: number;
  slug: string;
  name: string;
  client_id: string;
  client_secret: string;
  pem: string;
  html_url: string;
  owner?: { login?: string } | null;
}

/**
 * Redeems the one-time code for the App's credentials. Needs no
 * authentication — possession of the code *is* the authentication, which
 * is why the code never touches disk, a log line, or an error message.
 */
export async function exchangeManifestCode(
  code: string,
  options: { fetchImpl?: typeof fetch; apiBaseUrl?: string } = {},
): Promise<ManifestConversion> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.apiBaseUrl ?? "https://api.github.com";

  const response = await fetchImpl(`${baseUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "cimisy-setup",
    },
  });

  if (response.status !== 201) {
    // GitHub's own message is the useful part (e.g. "Code expired"); the
    // code itself is deliberately absent from anything we surface.
    const detail = await readGithubErrorMessage(response);
    throw new Error(`GitHub refused to convert the App manifest (HTTP ${response.status})${detail ? `: ${detail}` : ""}.`);
  }

  const data = (await response.json()) as Partial<ManifestConversion>;
  const missing = (["id", "slug", "client_id", "client_secret", "pem", "html_url"] as const).filter((key) => !data[key]);
  if (missing.length > 0) {
    throw new Error(`GitHub's manifest conversion response was missing: ${missing.join(", ")}.`);
  }
  return data as ManifestConversion;
}

async function readGithubErrorMessage(response: { json(): Promise<unknown> }): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string") {
      return (body as { message: string }).message;
    }
  } catch {
    // Non-JSON error body — the status code alone will have to do.
  }
  return "";
}
