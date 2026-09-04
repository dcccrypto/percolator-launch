import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Modal } from "@/components/ui/Modal";

/**
 * GH#2286 — the shared modal shell.
 *
 * The issue asked for this primitive to collapse six divergent hand-rolled modals.
 * By the time it was picked up the divergence had largely been closed piecemeal, so
 * what the primitive actually buys is the thing that was uniformly MISSING rather
 * than uniformly inconsistent: the two explainer modals trapped no focus at all.
 *
 * That is the failure mode of piecemeal convergence — five copies agreeing with
 * each other looks finished, and just means the gap is in all of them.
 */

afterEach(() => {
  cleanup();
  delete document.body.dataset.percOpenDialogs;
});

function Fixture({ onClose = () => {}, dismissible = true }) {
  return (
    <Modal onClose={onClose} dismissible={dismissible} panelClassName="panel">
      <button>first</button>
      <button>middle</button>
      <button>last</button>
    </Modal>
  );
}

describe("Modal traps focus (GH#2286)", () => {
  it("moves focus into the dialog on open", () => {
    render(<Fixture />);
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("wraps Tab from the last element back to the first", () => {
    // THE FIX. Without it Tab walks out of the dialog and into the page behind the
    // scrim — still scrolled where it was, still carrying live trade controls, and
    // invisible under an 80%-opaque overlay. A keyboard user could operate a page
    // they cannot see.
    render(<Fixture />);
    screen.getByText("last").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("wraps Shift+Tab from the first element to the last", () => {
    render(<Fixture />);
    screen.getByText("first").focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("last"));
  });

  it("does not hijack Tab BETWEEN elements", () => {
    // A trap that swallowed every Tab would pass the wrap tests above while making
    // the dialog unnavigable. The browser must still do ordinary movement.
    render(<Fixture />);
    screen.getByText("first").focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
  });
});

describe("Modal dismissal (GH#2286)", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape when not dismissible", () => {
    // SendPositionNftModal needs this while a transfer is in flight — dismissing
    // mid-signature leaves the user unsure whether the transaction went out.
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} dismissible={false} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Modal nested-dialog counter (GH#2286)", () => {
  it("marks the body while open and clears it on unmount", () => {
    // The Position NFT panel opens from inside the mobile order sheet, whose own
    // document-level Escape handler collapses the sheet. Without this counter one
    // Escape fired BOTH. Three modals each carried a copy; it lives here now.
    const { unmount } = render(<Fixture />);
    expect(document.body.dataset.percOpenDialogs).toBe("1");
    unmount();
    expect(document.body.dataset.percOpenDialogs).toBeUndefined();
  });

  it("counts nested dialogs rather than clobbering", () => {
    const { unmount: closeOuter } = render(<Fixture />);
    const { unmount: closeInner } = render(<Fixture />);
    expect(document.body.dataset.percOpenDialogs).toBe("2");
    closeInner();
    expect(document.body.dataset.percOpenDialogs).toBe("1");
    closeOuter();
    expect(document.body.dataset.percOpenDialogs).toBeUndefined();
  });
});
