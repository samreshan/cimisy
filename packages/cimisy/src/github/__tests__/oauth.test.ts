import { afterEach, describe, expect, it, vi } from "vitest";
import { CimisyError } from "../../shared/errors.js";
import { buildAuthorizeUrl, exchangeCodeForIdentity } from "../oauth.js";

describe("buildAuthorizeUrl", () => {
  it("builds a github.com authorize URL with no extra scopes requested", () => {
    const url = buildAuthorizeUrl({ clientId: "abc123", redirectUri: "https://example.com/cb", state: "xyz" });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("abc123");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
    expect(parsed.searchParams.get("state")).toBe("xyz");
    expect(parsed.searchParams.has("scope")).toBe(false);
  });
});

describe("exchangeCodeForIdentity", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("exchanges a code for an access token, fetches identity, and never exposes the token onward", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gho_faketoken" }), { status: 200 });
      }
      if (url === "https://api.github.com/user") {
        return new Response(
          JSON.stringify({ id: 42, login: "octocat", name: "The Octocat", email: null }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const identity = await exchangeCodeForIdentity({
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "the-code",
      redirectUri: "https://example.com/cb",
    });

    expect(identity).toEqual({ id: "42", login: "octocat", name: "The Octocat", email: null });

    // Assert the token-exchange request carried the code and never leaked
    // client_secret into a URL (it must be in the POST body, not a query string).
    const tokenCall = fetchMock.mock.calls.find(([input]) => String(input).includes("access_token"));
    expect(tokenCall).toBeDefined();
    const [tokenUrl, tokenInit] = tokenCall!;
    expect(tokenUrl).not.toContain("client-secret");
    expect(JSON.parse(String(tokenInit?.body))).toMatchObject({ code: "the-code", client_secret: "client-secret" });
  });

  it("throws when the token exchange fails", async () => {
    global.fetch = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    await expect(
      exchangeCodeForIdentity({ clientId: "a", clientSecret: "b", code: "bad-code", redirectUri: "https://x/cb" }),
    ).rejects.toThrow(CimisyError);
  });

  it("throws when GitHub returns an error instead of an access token", async () => {
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      exchangeCodeForIdentity({ clientId: "a", clientSecret: "b", code: "bad-code", redirectUri: "https://x/cb" }),
    ).rejects.toThrow(CimisyError);
  });

  it("throws when the user-identity fetch fails", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("access_token")) {
        return new Response(JSON.stringify({ access_token: "gho_faketoken" }), { status: 200 });
      }
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    await expect(
      exchangeCodeForIdentity({ clientId: "a", clientSecret: "b", code: "code", redirectUri: "https://x/cb" }),
    ).rejects.toThrow(CimisyError);
  });
});
