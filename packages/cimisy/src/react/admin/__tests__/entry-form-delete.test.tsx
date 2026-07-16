// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionManifest } from "../../../next/manifest.js";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

const { EntryForm } = await import("../entry-form.js");

const collection: CollectionManifest = {
  kind: "collection",
  key: "posts",
  label: "Posts",
  slugField: "slug",
  fields: [
    { name: "title", kind: "text", label: "Title" },
    { name: "slug", kind: "slug", label: "Slug" },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * EntryForm renders HistoryPanel alongside itself, so fetches must be routed
 * by URL rather than queued with mockResolvedValueOnce — effect ordering
 * between the two components is not stable.
 */
function routeFetches(deleteResponse?: () => Response): void {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "DELETE") {
      return Promise.resolve(deleteResponse ? deleteResponse() : jsonResponse({ error: "unexpected DELETE" }, 500));
    }
    if (url.endsWith("/history")) {
      return Promise.resolve(jsonResponse({ supported: false, history: [] }));
    }
    return Promise.resolve(
      jsonResponse({ entry: { slug: "hello", version: "v1", values: { title: "Hello", slug: "hello" } } }),
    );
  });
}

function deleteCalls(): [RequestInfo | URL, RequestInit | undefined][] {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE") as [
    RequestInfo | URL,
    RequestInit | undefined,
  ][];
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  push.mockClear();
  refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EntryForm delete", () => {
  it("hides the delete button for new entries", async () => {
    routeFetches();
    render(<EntryForm collection={collection} slug={null} basePath="/admin" apiBasePath="/api/cimisy" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Delete entry" })).toBeNull();
  });

  it("requires the two-step confirm, sends DELETE with baseVersion, and navigates on direct delete", async () => {
    routeFetches(() => jsonResponse({ ok: true, publish: { status: "direct" } }));
    render(<EntryForm collection={collection} slug="hello" basePath="/admin" apiBasePath="/api/cimisy" />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete entry" }));
    // No request yet — only the confirm step is showing.
    expect(deleteCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Really delete?" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/posts"));
    const [url, init] = deleteCalls()[0]!;
    expect(String(url)).toBe("/api/cimisy/collections/posts/hello");
    expect(JSON.parse(String(init?.body))).toEqual({ baseVersion: "v1" });
  });

  it("cancel backs out of the confirm step without a request", async () => {
    routeFetches();
    render(<EntryForm collection={collection} slug="hello" basePath="/admin" apiBasePath="/api/cimisy" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete entry" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Delete entry" })).toBeTruthy();
    expect(deleteCalls()).toHaveLength(0);
  });

  it("stays on the form and surfaces the PR when deletion lands as a draft", async () => {
    routeFetches(() =>
      jsonResponse({
        ok: true,
        publish: { status: "draft", branch: "cimisy/sam/posts/hello", pullRequestUrl: "https://github.com/x/pr/1" },
      }),
    );
    render(<EntryForm collection={collection} slug="hello" basePath="/admin" apiBasePath="/api/cimisy" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete entry" }));
    fireEvent.click(screen.getByRole("button", { name: "Really delete?" }));

    await waitFor(() => expect(screen.getByText(/Deletion opened as a draft pull request/)).toBeTruthy());
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText("cimisy/sam/posts/hello")).toBeTruthy();
  });

  it("shows the conflict error on a 409", async () => {
    routeFetches(() => jsonResponse({ error: "Version conflict" }, 409));
    render(<EntryForm collection={collection} slug="hello" basePath="/admin" apiBasePath="/api/cimisy" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete entry" }));
    fireEvent.click(screen.getByRole("button", { name: "Really delete?" }));
    await waitFor(() => expect(screen.getByText("Version conflict")).toBeTruthy());
    expect(push).not.toHaveBeenCalled();
  });
});
