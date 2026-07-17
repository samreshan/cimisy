// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { draftStorageKey, useLocalDraft } from "../use-local-draft.js";
import { useSaveShortcut } from "../use-save-shortcut.js";

// Vitest's jsdom environment ships no window.localStorage (Node's own
// experimental localStorage global gets in the way) — a plain in-memory
// stand-in matches the Storage surface the hook touches.
beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
});

function Harness({ storageKey, ready }: { storageKey: string; ready: boolean }) {
  const [values, setValues] = useState<Record<string, unknown>>({ title: "server" });
  const [dirty, setDirty] = useState(false);
  const { pendingDraft, restoreDraft, discardDraft, clearDraft } = useLocalDraft({ storageKey, ready, values, dirty });

  if (pendingDraft) {
    return (
      <div>
        <p>restore prompt</p>
        <button
          onClick={() => {
            const restored = restoreDraft();
            if (restored) setValues(restored);
          }}
        >
          restore
        </button>
        <button onClick={discardDraft}>discard</button>
      </div>
    );
  }
  return (
    <div>
      <p data-testid="title">{String(values.title)}</p>
      <button
        onClick={() => {
          setValues({ title: "edited" });
          setDirty(true);
        }}
      >
        edit
      </button>
      <button
        onClick={() => {
          setDirty(false);
          clearDraft();
        }}
      >
        save
      </button>
    </div>
  );
}

describe("useLocalDraft", () => {
  const KEY = draftStorageKey("posts", "hello");

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("debounce-writes a snapshot once dirty, and clears it on save", async () => {
    render(<Harness storageKey={KEY} ready />);
    expect(window.localStorage.getItem(KEY)).toBeNull();

    act(() => screen.getByText("edit").click());
    act(() => vi.advanceTimersByTime(1000));
    const raw = window.localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ values: { title: "edited" } });

    act(() => screen.getByText("save").click());
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("offers a differing snapshot on load and restores its values", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ values: { title: "recovered" }, savedAt: new Date(0).toISOString() }));
    render(<Harness storageKey={KEY} ready />);
    expect(screen.getByText("restore prompt")).toBeTruthy();

    act(() => screen.getByText("restore").click());
    expect(screen.getByTestId("title").textContent).toBe("recovered");
  });

  it("discards silently when the snapshot matches the server values (no prompt)", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ values: { title: "server" }, savedAt: new Date(0).toISOString() }));
    render(<Harness storageKey={KEY} ready />);
    expect(screen.queryByText("restore prompt")).toBeNull();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("discard removes the snapshot and shows the form", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ values: { title: "recovered" }, savedAt: new Date(0).toISOString() }));
    render(<Harness storageKey={KEY} ready />);
    act(() => screen.getByText("discard").click());
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(screen.getByTestId("title").textContent).toBe("server");
  });

  it("ignores a corrupted snapshot instead of crashing", () => {
    window.localStorage.setItem(KEY, "{not json");
    render(<Harness storageKey={KEY} ready />);
    expect(screen.queryByText("restore prompt")).toBeNull();
    expect(screen.getByTestId("title").textContent).toBe("server");
  });
});

describe("useSaveShortcut", () => {
  afterEach(cleanup);

  function ShortcutHarness({ onSave }: { onSave: () => void }) {
    useSaveShortcut(onSave);
    return <p>editor</p>;
  }

  it("fires on Cmd+S and Ctrl+S, and prevents the browser save dialog", () => {
    const onSave = vi.fn();
    render(<ShortcutHarness onSave={onSave} />);

    const cmdS = new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true });
    window.dispatchEvent(cmdS);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(cmdS.defaultPrevented).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "S", ctrlKey: true, cancelable: true }));
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("does not fire on plain S or Cmd+Shift+S", () => {
    const onSave = vi.fn();
    render(<ShortcutHarness onSave={onSave} />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, shiftKey: true, cancelable: true }));
    expect(onSave).not.toHaveBeenCalled();
  });
});
