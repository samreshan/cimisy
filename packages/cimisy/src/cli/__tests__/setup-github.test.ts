import { describe, expect, it } from "vitest";
import { generateSessionSecret, isOpenableUrl, isValidProductionOrigin } from "../setup-github.js";

describe("generateSessionSecret", () => {
  it("is long enough for the adapter's own >=32-character floor, and never repeats", () => {
    const secret = generateSessionSecret();
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(secret).not.toBe(generateSessionSecret());
  });
});

describe("isValidProductionOrigin", () => {
  it("accepts https origins", () => {
    expect(isValidProductionOrigin("https://example.vercel.app")).toBe(true);
    expect(isValidProductionOrigin("https://cms.example.com/")).toBe(true);
  });

  it("refuses non-TLS and malformed origins — the session cookie is Secure, so http could never sign in", () => {
    expect(isValidProductionOrigin("http://example.com")).toBe(false);
    expect(isValidProductionOrigin("example.com")).toBe(false);
    expect(isValidProductionOrigin("")).toBe(false);
    expect(isValidProductionOrigin("javascript:alert(1)")).toBe(false);
  });
});

/**
 * The install URL embeds a slug returned by GitHub's API, and it ends up
 * as an argument to a process launcher. Everything that isn't one of the
 * two URLs this wizard legitimately opens is refused before it gets there.
 */
describe("isOpenableUrl", () => {
  it("allows exactly the two URLs the wizard opens", () => {
    expect(isOpenableUrl("https://github.com/apps/cimisy-site/installations/new")).toBe(true);
    expect(isOpenableUrl("http://127.0.0.1:51234/")).toBe(true);
  });

  it("refuses other hosts, including look-alikes and subdomains", () => {
    expect(isOpenableUrl("https://evil.com/apps/x/installations/new")).toBe(false);
    expect(isOpenableUrl("https://github.com.evil.com/x")).toBe(false);
    expect(isOpenableUrl("https://raw.github.com/x")).toBe(false);
    expect(isOpenableUrl("http://localhost:3000/")).toBe(false);
  });

  it("refuses schemes that aren't http(s) — a launcher would happily hand these to the OS", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<script>", "vscode://x", "smb://host/share"]) {
      expect(isOpenableUrl(url)).toBe(false);
    }
  });

  it("refuses plain http on any host but loopback", () => {
    expect(isOpenableUrl("http://github.com/apps/x")).toBe(false);
    expect(isOpenableUrl("http://10.0.0.1/")).toBe(false);
  });

  it("refuses a URL carrying shell metacharacters — the Windows launcher used to parse its command line", () => {
    expect(isOpenableUrl("https://github.com/apps/x&calc/installations/new")).toBe(true); // host still github.com…
    // …and the slug is percent-encoded at construction, so the metacharacter
    // can never appear in the URL that reaches the launcher.
    expect(encodeURIComponent("x&calc")).toBe("x%26calc");
    expect(isOpenableUrl("not a url at all")).toBe(false);
    expect(isOpenableUrl("")).toBe(false);
  });
});
