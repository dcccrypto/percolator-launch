/**
 * The mobile Trade band is portaled to <body> at z-40 (PR #2781). Several
 * trade-page dialogs still render inline inside the layout's `relative z-[1]`
 * page wrapper, so in the root stacking context they are capped at z-1 and the
 * band would paint over their buttons. The band must step aside whenever any
 * other modal dialog is showing, at phone width (375px).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { readFileSync } from "fs";
import path from "path";
import { useRef, useState } from "react";
import { MobileTradeBand } from "@/components/trade/MobileTradeBand";

function Harness({ initialOpen = false }: { initialOpen?: boolean }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(initialOpen);
  return (
    <div className="relative z-[1]" data-testid="page-wrapper">
      <MobileTradeBand open={open} onOpen={() => setOpen(true)} label={null} ticketRow={null} sheetRef={sheetRef} />
      {/* the order sheet itself: a modal dialog, inert while closed */}
      <div ref={sheetRef} role="dialog" aria-modal="true" inert={!open ? true : undefined} data-testid="sheet" />
    </div>
  );
}

function addInlineDialog(attrs: Record<string, string> = {}): HTMLElement {
  const wrapper = screen.getByTestId("page-wrapper");
  const el = document.createElement("div");
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.className = "fixed inset-0 z-50";
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  wrapper.appendChild(el);
  return el;
}

async function flush() {
  // MutationObserver callbacks run as microtasks.
  await act(async () => { await Promise.resolve(); });
}

describe("MobileTradeBand vs dialogs at 375px", () => {
  let prevWidth: number;
  beforeEach(() => {
    prevWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 375 });
    window.dispatchEvent(new Event("resize"));
  });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: prevWidth });
  });

  it("is portaled to <body> at z-40, outside the page wrapper", async () => {
    render(<Harness />);
    await flush();
    const band = screen.getByTestId("mobile-trade-band");
    expect(band.parentElement).toBe(document.body);
    expect(screen.getByTestId("page-wrapper").contains(band)).toBe(false);
    expect(band.className).toMatch(/\bz-40\b/);
    expect(band.className).toMatch(/\blg:hidden\b/);
  });

  it("stays visible with only its own (closed, inert) sheet mounted", async () => {
    render(<Harness />);
    await flush();
    expect(screen.queryByTestId("mobile-trade-band")).not.toBeNull();
  });

  it("does not hide because of its own open sheet", async () => {
    render(<Harness initialOpen />);
    await flush();
    expect(screen.queryByTestId("mobile-trade-band")).not.toBeNull();
  });

  it("steps aside while an inline modal dialog is open, and returns after it closes", async () => {
    render(<Harness />);
    await flush();
    expect(screen.queryByTestId("mobile-trade-band")).not.toBeNull();

    const dialog = addInlineDialog();
    await flush();
    expect(screen.queryByTestId("mobile-trade-band")).toBeNull();

    dialog.remove();
    await flush();
    expect(screen.queryByTestId("mobile-trade-band")).not.toBeNull();
  });

  it("steps aside for a dialog portaled straight into <body> (wallet / confirm modals)", async () => {
    render(<Harness />);
    await flush();
    const el = document.createElement("div");
    el.setAttribute("aria-modal", "true");
    document.body.appendChild(el);
    await flush();
    expect(screen.queryByTestId("mobile-trade-band")).toBeNull();
    el.remove();
    await flush();
    expect(screen.queryByTestId("mobile-trade-band")).not.toBeNull();
  });

  it("ignores a mounted-but-inert or hidden dialog", async () => {
    render(<Harness />);
    await flush();
    const inert = addInlineDialog({ inert: "" });
    const hidden = addInlineDialog({ hidden: "" });
    await flush();
    expect(screen.queryByTestId("mobile-trade-band")).not.toBeNull();

    inert.removeAttribute("inert");
    await flush();
    expect(screen.queryByTestId("mobile-trade-band")).toBeNull();
    inert.remove();
    hidden.remove();
  });

  it("the inline trade-page overlays declare themselves as modal dialogs", () => {
    // Add Margin and the oracle details panel render inline (not portaled), so
    // they must carry aria-modal for the band to see them.
    const root = path.resolve(__dirname, "../..");
    for (const f of ["components/trade/PositionPanel.tsx", "components/oracle/OracleDetailsPanel.tsx"]) {
      expect(readFileSync(path.join(root, f), "utf8"), f).toMatch(/aria-modal="true"/);
    }
    // The NFT Wrap sheet renders through the shared Modal, which carries aria-modal itself.
    expect(readFileSync(path.join(root, "components/trade/PositionNftMenu.tsx"), "utf8")).toMatch(/<Modal[\s>]/);
    expect(readFileSync(path.join(root, "components/ui/Modal.tsx"), "utf8")).toMatch(/aria-modal="true"/);
  });
});

describe("isInsideModalSurface (order-sheet iOS touchmove guard)", () => {
  it("lets touches inside the sheet or a dialog stacked on it scroll, blocks the page behind", async () => {
    const { isInsideModalSurface } = await import("@/hooks/useOtherModalOpen");
    const sheet = document.createElement("div");
    const sheetChild = document.createElement("button");
    sheet.appendChild(sheetChild);
    const confirm = document.createElement("div");
    confirm.setAttribute("aria-modal", "true");
    const confirmText = document.createTextNode("scrollable");
    const confirmInner = document.createElement("p");
    confirmInner.appendChild(confirmText);
    confirm.appendChild(confirmInner);
    const page = document.createElement("main");
    document.body.append(sheet, confirm, page);
    try {
      expect(isInsideModalSurface(sheetChild, sheet)).toBe(true);
      expect(isInsideModalSurface(confirmInner, sheet)).toBe(true);
      expect(isInsideModalSurface(confirmText, sheet)).toBe(true);
      expect(isInsideModalSurface(page, sheet)).toBe(false);
      expect(isInsideModalSurface(null, sheet)).toBe(false);
    } finally {
      sheet.remove(); confirm.remove(); page.remove();
    }
  });
});
