import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { collection, config, fields } from "../../config/index.js";
import { unconfiguredSource } from "../../storage/unconfigured.js";
import { createCimisyHandler } from "../route-handler.js";

const MISSING = ["CIMISY_GITHUB_APP_PRIVATE_KEY", "CIMISY_SESSION_SECRET"];

function unconfiguredHandler() {
  return createCimisyHandler(
    config({
      source: unconfiguredSource({ missing: MISSING }),
      collections: {
        posts: collection({
          label: "Posts",
          path: "content/posts/*.mdx",
          slugField: "slug",
          schema: { title: fields.text({ label: "Title" }), slug: fields.slug({ source: "title" }) },
        }),
      },
    }),
  );
}

function req(path: string, method = "GET"): NextRequest {
  const url = new URL(path, "http://localhost:3000");
  return new NextRequest(url, { method, headers: { origin: url.origin } });
}

describe("createCimisyHandler with an unconfigured source", () => {
  it("answers 503 on every method and route, not 500", async () => {
    const handler = unconfiguredHandler();
    const cases: Array<[keyof ReturnType<typeof createCimisyHandler>, string[]]> = [
      ["GET", ["collections", "posts"]],
      ["GET", ["auth", "me"]],
      ["GET", ["media"]],
      ["POST", ["collections", "posts"]],
      ["PUT", ["singletons", "settings"]],
      ["DELETE", ["collections", "posts", "hello"]],
    ];
    for (const [method, route] of cases) {
      const res = await handler[method](req(`/api/cimisy/${route.join("/")}`, method), { params: Promise.resolve({ route }) });
      expect(res.status).toBe(503);
    }
  });

  it("names the missing variables — names only, no values and no stack trace", async () => {
    const handler = unconfiguredHandler();
    const res = await handler.GET(req("/api/cimisy/collections/posts"), { params: Promise.resolve({ route: ["collections", "posts"] }) });
    const body = (await res.json()) as { error: string; missing: string[]; hint: string };
    expect(body.error).toBe("cimisy is not configured");
    expect(body.missing).toEqual(MISSING);
    expect(body.hint).toContain("cimisy setup github");
    expect(JSON.stringify(body)).not.toContain("Error:");
  });

  it("does not leak the auth routes — an unconfigured deploy has nothing to sign in to", async () => {
    const handler = unconfiguredHandler();
    const res = await handler.GET(req("/api/cimisy/auth/login"), { params: Promise.resolve({ route: ["auth", "login"] }) });
    expect(res.status).toBe(503);
  });
});
