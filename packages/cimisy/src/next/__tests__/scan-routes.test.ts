import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubSource } from "../../adapters/github/adapter.js";
import type { ResolvedCimisyConfig } from "../../config/define-config.js";
import { config } from "../../config/index.js";
import { localSource } from "../../storage/local.js";
import { createCimisyHandler } from "../route-handler.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): NextRequest {
  const parsedUrl = new URL(url, "http://localhost:3000");
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers);
  if (["POST", "PUT", "DELETE"].includes(method) && !headers.has("origin")) {
    headers.set("origin", parsedUrl.origin);
  }
  return new NextRequest(parsedUrl, { ...init, headers });
}

function params(...route: string[]): { params: Promise<{ route: string[] }> } {
  return { params: Promise.resolve({ route }) };
}

function localConfig(rootDir: string): ResolvedCimisyConfig {
  return config({ source: localSource({ rootDir }) });
}

function githubConfig(): ResolvedCimisyConfig {
  return config({
    source: githubSource({
      repo: "acme/site",
      branch: "main",
      appId: "1",
      privateKey,
      clientId: "client-id",
      clientSecret: "client-secret",
      sessionSecret: "test-session-secret-0123456789ab",
    }),
  });
}

describe("scan routes (/scan, /scan/report, /scan/import) — availability gate", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cimisy-scan-routes-"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("404s on every scan route when the source is the GitHub adapter", async () => {
    const handler = createCimisyHandler(githubConfig());
    const report = await handler.GET(req("/api/cimisy/scan/report"), params("scan", "report"));
    expect(report.status).toBe(404);
    const run = await handler.POST(req("/api/cimisy/scan", { method: "POST", body: "{}" }), params("scan"));
    expect(run.status).toBe(404);
    const imported = await handler.POST(
      req("/api/cimisy/scan/import", { method: "POST", body: JSON.stringify({ selections: [{ kind: "static", index: 0 }] }) }),
      params("scan", "import"),
    );
    expect(imported.status).toBe(404);
  });

  it("404s under NODE_ENV=production even with a local adapter (allowInProduction)", async () => {
    const handler = createCimisyHandler(
      config({ source: localSource({ rootDir: root, allowInProduction: true }) }),
    );
    vi.stubEnv("NODE_ENV", "production");
    const report = await handler.GET(req("/api/cimisy/scan/report"), params("scan", "report"));
    expect(report.status).toBe(404);
    const run = await handler.POST(req("/api/cimisy/scan", { method: "POST", body: "{}" }), params("scan"));
    expect(run.status).toBe(404);
  });

  it("returns { report: null } when no scan has been cached yet", async () => {
    const handler = createCimisyHandler(localConfig(root));
    const res = await handler.GET(req("/api/cimisy/scan/report"), params("scan", "report"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: null });
  });

  it("rejects a cross-origin scan run", async () => {
    const handler = createCimisyHandler(localConfig(root));
    const res = await handler.POST(
      req("/api/cimisy/scan", { method: "POST", body: "{}", headers: { origin: "https://evil.example" } }),
      params("scan"),
    );
    expect(res.status).toBe(403);
  });

  it("runs a scan, caches the report, and serves it back path-relativized", async () => {
    const appDir = path.join(root, "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      path.join(appDir, "page.tsx"),
      `const faqs = [
        { question: "What is this?", answer: "A test." },
        { question: "Why?", answer: "Because." },
      ];
      export default function Page() {
        return <ul>{faqs.map((f) => (<li key={f.question}>{f.question}: {f.answer}</li>))}</ul>;
      }
      `,
    );
    const handler = createCimisyHandler(localConfig(root));

    const run = await handler.POST(
      req("/api/cimisy/scan", { method: "POST", body: JSON.stringify({ mode: "collections" }) }),
      params("scan"),
    );
    expect(run.status).toBe(200);
    const runData = (await run.json()) as { report: { collectionCandidates: Array<{ variableName: string; sourceFile: string }> } };
    expect(runData.report.collectionCandidates.map((c) => c.variableName)).toEqual(["faqs"]);
    // Portable shape: project-root-relative posix paths, not absolute.
    expect(runData.report.collectionCandidates[0]!.sourceFile).toBe("app/page.tsx");

    const cached = await handler.GET(req("/api/cimisy/scan/report"), params("scan", "report"));
    const cachedData = (await cached.json()) as { report: { collectionCandidates: unknown[]; mode: string } };
    expect(cachedData.report.mode).toBe("collections");
    expect(cachedData.report.collectionCandidates).toHaveLength(1);
  });

  it("400s a scan run when the project has no app directory", async () => {
    const handler = createCimisyHandler(localConfig(root));
    const res = await handler.POST(req("/api/cimisy/scan", { method: "POST", body: "{}" }), params("scan"));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("app");
  });

  it("refuses to import outside a git repository, before touching anything", async () => {
    const appDir = path.join(root, "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      path.join(appDir, "page.tsx"),
      `const faqs = [
        { question: "What is this?", answer: "A test." },
        { question: "Why?", answer: "Because." },
      ];
      export default function Page() {
        return <ul>{faqs.map((f) => (<li key={f.question}>{f.question}: {f.answer}</li>))}</ul>;
      }
      `,
    );
    const handler = createCimisyHandler(localConfig(root));
    await handler.POST(req("/api/cimisy/scan", { method: "POST", body: JSON.stringify({ mode: "collections" }) }), params("scan"));

    const res = await handler.POST(
      req("/api/cimisy/scan/import", {
        method: "POST",
        body: JSON.stringify({ selections: [{ kind: "collection", index: 0 }] }),
      }),
      params("scan", "import"),
    );
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string; code: string };
    expect(data.code).toBe("NOT_A_GIT_REPO");
  });

  it("imports a selected candidate on a fresh cimisy/import-* branch (end to end)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { readFile } = await import("node:fs/promises");
    const appDir = path.join(root, "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      path.join(appDir, "page.tsx"),
      `const faqs = [
        { question: "What is this?", answer: "A test." },
        { question: "Why?", answer: "Because." },
      ];
      export default function Page() {
        return <ul>{faqs.map((f) => (<li key={f.question}>{f.question}: {f.answer}</li>))}</ul>;
      }
      `,
    );
    // Real projects gitignore the scan cache (README setup) — without this the
    // cache write itself would trip the clean-working-tree check.
    await writeFile(path.join(root, ".gitignore"), ".cimisy/\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed");

    const handler = createCimisyHandler(localConfig(root));
    await handler.POST(req("/api/cimisy/scan", { method: "POST", body: JSON.stringify({ mode: "collections" }) }), params("scan"));

    const res = await handler.POST(
      req("/api/cimisy/scan/import", {
        method: "POST",
        body: JSON.stringify({ selections: [{ kind: "collection", index: 0 }] }),
      }),
      params("scan", "import"),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { branch: string; results: Array<{ label: string; ok: boolean; itemsImported?: number }> };
    expect(data.branch).toMatch(/^cimisy\/import-\d+$/);
    expect(data.results).toEqual([expect.objectContaining({ label: "faqs", ok: true, itemsImported: 2 })]);

    // The import branch is checked out and the page's array was rewritten to read from cimisy.
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect(branch).toBe(data.branch);
    const rewritten = await readFile(path.join(appDir, "page.tsx"), "utf8");
    expect(rewritten).not.toContain('question: "What is this?"');
  });

  it("409s an import whose selection index isn't in the cached report", async () => {
    const appDir = path.join(root, "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(path.join(appDir, "page.tsx"), `export default function Page() { return <p>hi</p>; }`);
    const handler = createCimisyHandler(localConfig(root));
    await handler.POST(req("/api/cimisy/scan", { method: "POST", body: JSON.stringify({ mode: "collections" }) }), params("scan"));

    const res = await handler.POST(
      req("/api/cimisy/scan/import", {
        method: "POST",
        body: JSON.stringify({ selections: [{ kind: "collection", index: 5 }] }),
      }),
      params("scan", "import"),
    );
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("re-run the scan");
  });
});
