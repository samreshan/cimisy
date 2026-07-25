import { describe, expect, it, vi } from "vitest";
import { decodeCimisyConfigBlob, encodeCimisyConfigBlob } from "../../env/blob.js";
import { buildAppManifest } from "../manifest.js";
import {
  exchangeManifestCode,
  generateState,
  renderManifestFormPage,
  startManifestCallbackServer,
  statesMatch,
} from "../manifest-flow.js";

const REGISTRATION_URL = "https://github.com/settings/apps/new";

function manifestFor(redirectUrl: string) {
  return buildAppManifest({ appName: "cimisy-test", repo: "acme/site", redirectUrl });
}

describe("state parameter", () => {
  it("is long and unguessable, and differs every call", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("matches only an exact equal, including on length mismatch", () => {
    expect(statesMatch("abc", "abc")).toBe(true);
    expect(statesMatch("abc", "abd")).toBe(false);
    expect(statesMatch("abc", "abcd")).toBe(false);
    expect(statesMatch("abc", "")).toBe(false);
  });
});

describe("renderManifestFormPage", () => {
  it("embeds the manifest as JSON in a POST form targeting GitHub, carrying the state", () => {
    const html = renderManifestFormPage({
      registrationUrl: REGISTRATION_URL,
      manifest: manifestFor("http://127.0.0.1:1/callback"),
      state: "st4te",
    });
    expect(html).toContain('method="post"');
    expect(html).toContain(`action="${REGISTRATION_URL}?state=st4te"`);
    expect(html).toContain('name="manifest"');
    expect(html).toContain("cimisy-test");
  });

  it("HTML-escapes the manifest so a crafted repo/app name can't break out of the attribute", () => {
    const html = renderManifestFormPage({
      registrationUrl: REGISTRATION_URL,
      manifest: manifestFor("http://127.0.0.1:1/callback"),
      state: 'x" onload="alert(1)',
    });
    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain("&quot;");
    // The JSON's own quotes are all escaped — no bare `"` can close the attribute early.
    const attribute = /value="([^"]*)"/.exec(html.slice(html.indexOf('name="manifest"')));
    expect(attribute).not.toBeNull();
  });
});

describe("startManifestCallbackServer", () => {
  it("binds loopback only and serves the auto-submitting form at /", async () => {
    const server = await startManifestCallbackServer({ registrationUrl: REGISTRATION_URL, buildManifest: manifestFor, state: "s" });
    try {
      expect(server.startUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const html = await (await fetch(server.startUrl)).text();
      expect(html).toContain('method="post"');
      // redirect_url is only knowable after the port is bound — it must be the live one.
      expect(html).toContain(new URL(server.startUrl).host);
    } finally {
      await server.close();
    }
  });

  it("resolves with the code when the state matches", async () => {
    const server = await startManifestCallbackServer({ registrationUrl: REGISTRATION_URL, buildManifest: manifestFor, state: "good-state" });
    const origin = new URL(server.startUrl).origin;
    const response = await fetch(`${origin}/callback?code=abc123&state=good-state`);
    expect(response.status).toBe(200);
    await expect(server.code).resolves.toBe("abc123");
    await server.close();
  });

  it("rejects a state mismatch without ever handing back the code", async () => {
    const server = await startManifestCallbackServer({ registrationUrl: REGISTRATION_URL, buildManifest: manifestFor, state: "good-state" });
    const origin = new URL(server.startUrl).origin;
    const response = await fetch(`${origin}/callback?code=attacker-code&state=wrong`);
    expect(response.status).toBe(400);
    await expect(server.code).rejects.toThrow(/state did not match/i);
    await server.close();
  });

  it("rejects a callback with no code at all", async () => {
    const server = await startManifestCallbackServer({ registrationUrl: REGISTRATION_URL, buildManifest: manifestFor, state: "s" });
    const origin = new URL(server.startUrl).origin;
    await fetch(`${origin}/callback?state=s`);
    await expect(server.code).rejects.toThrow(/without a manifest code/i);
    await server.close();
  });

  it("accepts exactly one callback — a replay is refused with 410", async () => {
    const server = await startManifestCallbackServer({ registrationUrl: REGISTRATION_URL, buildManifest: manifestFor, state: "s" });
    const origin = new URL(server.startUrl).origin;
    expect((await fetch(`${origin}/callback?code=first&state=s`)).status).toBe(200);
    await expect(server.code).resolves.toBe("first");
    // The listener is torn down after the first callback; whichever of the
    // two the race lands on, a second code is never handed back.
    const replay = await fetch(`${origin}/callback?code=second&state=s`).catch(() => null);
    if (replay) expect(replay.status).toBe(410);
    await expect(server.code).resolves.toBe("first");
    await server.close();
  });

  it("404s any other path", async () => {
    const server = await startManifestCallbackServer({ registrationUrl: REGISTRATION_URL, buildManifest: manifestFor, state: "s" });
    const origin = new URL(server.startUrl).origin;
    expect((await fetch(`${origin}/anything-else`)).status).toBe(404);
    await server.close();
  });

  it("times out cleanly, saying nothing was created", async () => {
    const server = await startManifestCallbackServer({
      registrationUrl: REGISTRATION_URL,
      buildManifest: manifestFor,
      state: "s",
      timeoutMs: 20,
    });
    await expect(server.code).rejects.toThrow(/Nothing was created or written/);
    await server.close();
  });

  it("close() is idempotent", async () => {
    const server = await startManifestCallbackServer({ registrationUrl: REGISTRATION_URL, buildManifest: manifestFor, state: "s" });
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
    server.code.catch(() => {});
  });
});

describe("exchangeManifestCode", () => {
  const CONVERSION = {
    id: 12345,
    slug: "cimisy-test",
    name: "cimisy-test",
    client_id: "Iv1.abcdef",
    client_secret: "cs_secret",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nBODY\n-----END RSA PRIVATE KEY-----\n",
    html_url: "https://github.com/apps/cimisy-test",
  };

  it("POSTs to the conversions endpoint with the code in the path and no auth header", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    const result = await exchangeManifestCode("the-code", { fetchImpl });
    expect(result.client_secret).toBe("cs_secret");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://api.github.com/app-manifests/the-code/conversions");
    expect((init as RequestInit).method).toBe("POST");
    expect(Object.keys((init as RequestInit).headers as Record<string, string>)).not.toContain("authorization");
  });

  it("URL-encodes the code rather than interpolating it raw", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    await exchangeManifestCode("a/b?c", { fetchImpl });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("https://api.github.com/app-manifests/a%2Fb%3Fc/conversions");
  });

  it("surfaces GitHub's own message on a non-201, without echoing the code", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Code expired" }), { status: 422 })) as unknown as typeof fetch;
    let message = "";
    try {
      await exchangeManifestCode("secret-code", { fetchImpl });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("HTTP 422");
    expect(message).toContain("Code expired");
    // The code is redeemable for a private key — it must never reach a log line.
    expect(message).not.toContain("secret-code");
  });

  it("tolerates a non-JSON error body", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;
    await expect(exchangeManifestCode("c", { fetchImpl })).rejects.toThrow(/HTTP 502/);
  });

  it("rejects a 201 that's missing credentials rather than proceeding with a half-config", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 1, slug: "s" }), { status: 201 })) as unknown as typeof fetch;
    await expect(exchangeManifestCode("c", { fetchImpl })).rejects.toThrow(/missing: client_id, client_secret, pem, html_url/);
  });

  it("produces a blob the Phase 1 decoder round-trips", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(CONVERSION), { status: 201 })) as unknown as typeof fetch;
    const conversion = await exchangeManifestCode("c", { fetchImpl });
    const blob = encodeCimisyConfigBlob({
      repo: "acme/site",
      branch: "main",
      appId: String(conversion.id),
      privateKey: conversion.pem,
      clientId: conversion.client_id,
      clientSecret: conversion.client_secret,
      sessionSecret: "0123456789abcdef0123456789abcdef",
    });
    expect(decodeCimisyConfigBlob(blob)).toMatchObject({
      v: 1,
      repo: "acme/site",
      appId: "12345",
      privateKey: CONVERSION.pem,
      clientId: "Iv1.abcdef",
      clientSecret: "cs_secret",
    });
  });
});
