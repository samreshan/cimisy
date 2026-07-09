import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  generateOauthState,
  oauthStateMatches,
  verifySessionToken,
} from "../session.js";

const PAYLOAD = { githubUserId: "123", githubLogin: "octocat", name: "The Octocat", email: null };
const SECRET = "test-session-secret";

describe("session token sign/verify", () => {
  it("round-trips a valid token", async () => {
    const token = await createSessionToken(PAYLOAD, SECRET);
    const verified = await verifySessionToken(token, SECRET);
    expect(verified).toEqual(PAYLOAD);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(PAYLOAD, SECRET);
    expect(await verifySessionToken(token, "wrong-secret")).toBeNull();
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const token = await createSessionToken(PAYLOAD, SECRET);
    const [header, payload, signature] = token.split(".");
    const tamperedPayloadJson = JSON.stringify({
      ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
      githubLogin: "attacker",
    });
    const tamperedPayload = Buffer.from(tamperedPayloadJson).toString("base64url");
    const tamperedToken = `${header}.${tamperedPayload}.${signature}`;
    expect(await verifySessionToken(tamperedToken, SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    // Sign a token that's already expired by constructing one with jose directly.
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const expiredToken = await new SignJWT({ ...PAYLOAD })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 1000)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 500)
      .sign(key);
    expect(await verifySessionToken(expiredToken, SECRET)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifySessionToken("not-a-jwt", SECRET)).toBeNull();
    expect(await verifySessionToken("", SECRET)).toBeNull();
  });

  it("rejects a token missing required claims", async () => {
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(SECRET);
    const incompleteToken = await new SignJWT({ githubUserId: "123" }) // missing githubLogin
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
    expect(await verifySessionToken(incompleteToken, SECRET)).toBeNull();
  });

  it("rejects a token signed with alg=none (alg-confusion attempt)", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(PAYLOAD)).toString("base64url");
    const forgedToken = `${header}.${payload}.`;
    expect(await verifySessionToken(forgedToken, SECRET)).toBeNull();
  });
});

describe("oauth state", () => {
  it("generates state values that are unpredictable and reasonably long", () => {
    const a = generateOauthState();
    const b = generateOauthState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it("matches identical cookie/query values", () => {
    const state = generateOauthState();
    expect(oauthStateMatches(state, state)).toBe(true);
  });

  it("rejects mismatched values", () => {
    expect(oauthStateMatches(generateOauthState(), generateOauthState())).toBe(false);
  });

  it("rejects when either side is missing", () => {
    expect(oauthStateMatches(undefined, "something")).toBe(false);
    expect(oauthStateMatches("something", null)).toBe(false);
  });
});
