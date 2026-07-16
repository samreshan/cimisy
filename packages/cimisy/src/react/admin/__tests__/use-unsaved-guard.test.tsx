// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useUnsavedChangesGuard } from "../use-unsaved-guard.js";

function Harness({ dirty }: { dirty: boolean }) {
  useUnsavedChangesGuard(dirty);
  return (
    <div>
      <a href="/admin/posts" id="internal">
        Posts
      </a>
      <a href="https://example.com/elsewhere" id="external">
        Elsewhere
      </a>
    </div>
  );
}

function fireBeforeUnload(): BeforeUnloadEvent {
  const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(event);
  return event;
}

function clickAnchor(id: string): MouseEvent {
  const anchor = document.getElementById(id) as HTMLAnchorElement;
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  anchor.dispatchEvent(event);
  return event;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useUnsavedChangesGuard", () => {
  it("prevents beforeunload while dirty", () => {
    render(<Harness dirty={true} />);
    expect(fireBeforeUnload().defaultPrevented).toBe(true);
  });

  it("does nothing when not dirty", () => {
    render(<Harness dirty={false} />);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it("releases the guard when dirty flips back to false", () => {
    const { rerender } = render(<Harness dirty={true} />);
    rerender(<Harness dirty={false} />);
    expect(fireBeforeUnload().defaultPrevented).toBe(false);
  });

  it("confirms same-origin link clicks and blocks navigation on cancel", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Harness dirty={true} />);
    const event = clickAnchor("internal");
    expect(confirm).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets the click through when the user confirms", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Harness dirty={true} />);
    const event = clickAnchor("internal");
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores cross-origin links (beforeunload still covers them)", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Harness dirty={true} />);
    const event = clickAnchor("external");
    expect(confirm).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
