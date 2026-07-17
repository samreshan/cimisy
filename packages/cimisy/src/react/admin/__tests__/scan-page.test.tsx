// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScanPage } from "../scan.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const REPORT = {
  reportVersion: 1,
  mode: "static-metadata",
  generatedAt: new Date(0).toISOString(),
  appDir: "app",
  pages: [],
  collectionCandidates: [
    {
      variableName: "faqs",
      sourceFile: "app/page.tsx",
      declarationFile: "app/page.tsx",
      section: "page",
      itemCount: 2,
      proposal: { fields: [{ name: "question", proposedKind: "text" }], slugField: "slug", slugSourceField: "question" },
      items: [],
      declarationStart: 0,
      declarationEnd: 0,
      mapCallStart: 0,
      usedOnRoutes: ["/"],
    },
  ],
  unanalyzable: [
    {
      variableName: "nav",
      sourceFile: "app/layout.tsx",
      declarationFile: "app/layout.tsx",
      section: "layout",
      reason: "items are not object literals",
      usedOnRoutes: ["/"],
    },
  ],
  staticContentCandidates: [],
  staticUnanalyzable: [],
  pageMetadataCandidates: [],
  pageMetadataUnanalyzable: [],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ScanPage", () => {
  it("shows the no-scan-yet empty state when no report is cached", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ report: null }));
    render(<ScanPage basePath="/admin" apiBasePath="/api/cimisy" />);
    await waitFor(() => expect(screen.getByText("No scan yet")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Run scan" })).toBeTruthy();
  });

  it("renders a cached report's candidates and ineligible bucket, grouped", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ report: REPORT }));
    render(<ScanPage basePath="/admin" apiBasePath="/api/cimisy" />);
    await waitFor(() => expect(screen.getByText("Collection candidates")).toBeTruthy());
    expect(screen.getByText("faqs")).toBeTruthy();
    expect(screen.getByText("Detected but not import-eligible")).toBeTruthy();
    expect(screen.getByText(/items are not object literals/)).toBeTruthy();
    // Import bar disabled until something is selected.
    const importButton = screen.getByRole("button", { name: "Import selected" }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
  });

  it("selecting a candidate and importing posts the kind:index selection and shows per-candidate results", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ report: REPORT }))
      .mockResolvedValueOnce(
        jsonResponse({
          branch: "cimisy/import-123",
          results: [{ kind: "collection", index: 0, label: "faqs", ok: true, itemsImported: 2, itemsTotal: 2 }],
        }),
      );
    render(<ScanPage basePath="/admin" apiBasePath="/api/cimisy" />);
    const checkbox = (await screen.findAllByRole("checkbox"))[0]!;
    act(() => checkbox.click());
    const importButton = screen.getByRole("button", { name: "Import selected" });
    act(() => importButton.click());

    await waitFor(() => expect(screen.getByText(/cimisy\/import-123/)).toBeTruthy());
    expect(screen.getByText(/2\/2 items imported/)).toBeTruthy();
    // Report is now stale — importing again is blocked until a re-scan.
    expect(screen.getByText(/re-run the scan before importing/)).toBeTruthy();

    const [, importCall] = vi.mocked(fetch).mock.calls;
    expect(importCall![0]).toBe("/api/cimisy/scan/import");
    expect(JSON.parse((importCall![1] as RequestInit).body as string)).toEqual({
      selections: [{ kind: "collection", index: 0 }],
    });
  });

  it("surfaces a dirty-tree 409 with the allow-dirty override checkbox", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ report: REPORT }))
      .mockResolvedValueOnce(jsonResponse({ error: "Working tree has uncommitted changes.", code: "DIRTY_TREE" }, 409));
    render(<ScanPage basePath="/admin" apiBasePath="/api/cimisy" />);
    const checkbox = (await screen.findAllByRole("checkbox"))[0]!;
    act(() => checkbox.click());
    act(() => screen.getByRole("button", { name: "Import selected" }).click());
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("uncommitted changes");
    expect(screen.getByText(/Import anyway/)).toBeTruthy();
  });
});
