// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionManifest } from "../../../next/manifest.js";
import { EntryList } from "../collections.js";
import { HistoryPanel } from "../history.js";

const collection: CollectionManifest = {
  kind: "collection",
  key: "posts",
  label: "Posts",
  slugField: "title",
  fields: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EntryList load failures", () => {
  it("shows an error with a Retry button on network failure instead of hanging on Loading…", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network down"));
    render(<EntryList collection={collection} basePath="/admin" apiBasePath="/api/cimisy" />);
    await waitFor(() => expect(screen.getByText(/Failed to load entries/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("shows the server error on a non-OK response instead of crashing on entries.length", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "Forbidden." }, 403));
    render(<EntryList collection={collection} basePath="/admin" apiBasePath="/api/cimisy" />);
    await waitFor(() => expect(screen.getByText(/Forbidden\./)).toBeTruthy());
  });

  it("retries the fetch when Retry is clicked and renders entries on success", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(jsonResponse({ entries: [{ slug: "hello", version: "v1", values: { title: "Hello" } }] }));
    render(<EntryList collection={collection} basePath="/admin" apiBasePath="/api/cimisy" />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    retry.click();
    await waitFor(() => expect(screen.getByText("Hello")).toBeTruthy());
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});

describe("HistoryPanel load failures", () => {
  it("still hides itself when the adapter reports history unsupported", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ supported: false, history: [] }));
    const { container } = render(<HistoryPanel historyPath="/collections/posts/hello/history" apiBasePath="/api/cimisy" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    await waitFor(() => expect(container.innerHTML).toBe(""));
  });

  it("shows an inline error with Retry on a non-OK response instead of vanishing", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500))
      .mockResolvedValueOnce(
        jsonResponse({
          supported: true,
          history: [{ version: "abcdef1234", message: "edit", author: { name: "Sam" }, date: "2026-07-01T00:00:00Z" }],
        }),
      );
    render(<HistoryPanel historyPath="/collections/posts/hello/history" apiBasePath="/api/cimisy" />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    retry.click();
    await waitFor(() => expect(screen.getByText(/edit/)).toBeTruthy());
  });
});
