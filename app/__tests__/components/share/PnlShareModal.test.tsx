/**
 * The share modal is portaled to <body>, but React portals bubble SYNTHETIC
 * events up the component tree — so on /portfolio (where the button lives inside
 * a row <Link>) a backdrop click would navigate unless the handler stops it.
 * These pin: the card renders with the live data, and a backdrop click closes
 * AND halts propagation (so no parent/Link onClick fires).
 */
import "@testing-library/jest-dom";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";

// Keep the live-price store inert — the card prices off data.initialMarkE6.
vi.mock("@/lib/priceStore/priceStore", () => ({
  subscribeSlab: () => () => {},
  getSnapshot: () => ({ priceUsd: null, priceE6: null }),
}));

import { PnlShareModal } from "@/components/share/PnlShareModal";
import type { PnlCardData } from "@/lib/pnl-card";

const DATA: PnlCardData = {
  slab: "So11111111111111111111111111111111111111112",
  symbol: "HOKK",
  name: "Hokkaido Coin",
  logoUrl: null,
  mintAddress: null, // no logo fetch
  decimals: 6,
  nominalSizeQ: 1_000_000_000n,
  effectiveSizeQ: 1_000_000_000n,
  entryE6: 400_000n,
  initialMarginBps: 1000n,
  initialMarkE6: 500_000n, // long, mark > entry → profit
};

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("PnlShareModal", () => {
  it("renders the card with the live data", () => {
    render(<PnlShareModal data={DATA} onClose={() => {}} />);
    expect(screen.getByText("Hokkaido Coin")).toBeInTheDocument();
    expect(screen.getByText("$HOKK")).toBeInTheDocument();
    expect(screen.getByText("Share to X")).toBeInTheDocument();
  });

  it("a backdrop click closes and stops propagation (no parent navigation through the portal)", () => {
    const onClose = vi.fn();
    const bubbledToDocument = vi.fn();
    document.addEventListener("click", bubbledToDocument);
    // container = document.body so React's delegated listener sits above the
    // portal and actually receives the dialog's click in jsdom.
    render(<PnlShareModal data={DATA} onClose={onClose} />, { container: document.body });

    fireEvent.click(screen.getByRole("dialog"));

    expect(onClose).toHaveBeenCalledTimes(1);
    // stopPropagation() in the backdrop handler also halts native bubbling, so a
    // listener above the modal (a parent onClick / the row <Link>) never fires.
    expect(bubbledToDocument).not.toHaveBeenCalled();
    document.removeEventListener("click", bubbledToDocument);
  });
});
