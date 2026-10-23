/**
 * N28: four dialogs were hand-rolled instead of on the shared Modal (GH#2286), so none moved, trapped
 * or restored keyboard focus: Tab walked the page behind the scrim and closing dropped focus at the
 * top of the document. Add Margin also had no Escape, an unlabelled amount field, and closed on a
 * backdrop click mid-deposit (taking its result line with it), under the header and tab bar.
 * Add Margin is now on <Modal>; the other three keep their layout and use its focus hook.
 */
import "@testing-library/jest-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";

const dep = vi.hoisted(() => ({ loading: false }));
vi.mock("@/hooks/useDeposit", () => ({ useDeposit: () => ({ deposit: vi.fn(), loading: dep.loading, error: null }) }));
vi.mock("@/hooks/useWalletAtaBalance", () => ({ useWalletAtaBalance: () => ({ balance: 100_000_000n, decimals: 6 }) }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ config: null }) }));
vi.mock("@/lib/priceStore/priceStore", () => ({ subscribeSlab: () => () => {}, getSnapshot: () => ({ priceUsd: null, priceE6: null }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceUsd: 1.23 }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({
  useOracleFreshness: () => ({ mode: "admin", modeLabel: "Admin", elapsedSecs: 3, level: "fresh", color: "var(--long)" }),
}));
vi.mock("@/hooks/useOraclePublishers", () => ({ useOraclePublishers: () => ({ publisherCount: null, publisherTotal: null, publishers: [] }) }));
const faucet = vi.hoisted(() => ({ shouldShow: true }));
vi.mock("@/hooks/useDevnetFaucet", () => ({
  useDevnetFaucet: () => ({
    shouldShow: faucet.shouldShow, dismiss: vi.fn(), fundAll: vi.fn(), airdropSol: vi.fn(), airdropUsdc: vi.fn(),
    solBalance: 0, usdcBalance: 0, solDone: false, usdcDone: false, loading: false, error: null, step: "idle",
    rateLimited: false, nextClaimAt: null,
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/markets" }));

import { AddMarginModal } from "@/components/trade/AddMarginModal";
import { PnlShareModal } from "@/components/share/PnlShareModal";
import { OracleDetailsPanel } from "@/components/oracle/OracleDetailsPanel";
import { DevnetFaucetModal } from "@/components/devnet/DevnetFaucetModal";
import type { PnlCardData } from "@/lib/pnl-card";

afterEach(() => {
  cleanup();
  dep.loading = false;
  faucet.shouldShow = true;
  delete document.body.dataset.percOpenDialogs;
});

/** An opener button with focus, then the dialog. Returns a closer that unmounts the dialog. */
function openFrom(dialog: ReactNode) {
  let close!: () => void;
  function Host() {
    const [open, setOpen] = useState(false);
    close = () => setOpen(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>opener</button>
        {open && dialog}
      </>
    );
  }
  render(<Host />);
  const opener = screen.getByText("opener");
  opener.focus();
  fireEvent.click(opener);
  return { opener, close: () => act(() => close()) };
}

function expectFocusTrapped(dialog: HTMLElement) {
  expect(dialog.contains(document.activeElement)).toBe(true); // moved in on open
  const items = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],input:not([disabled])"));
  items[items.length - 1].focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(items[0]); // Tab wraps instead of leaving
}

const PNL: PnlCardData = {
  slab: "So11111111111111111111111111111111111111112", symbol: "HOKK", name: "Hokkaido Coin", logoUrl: null, mintAddress: null,
  decimals: 6, nominalSizeQ: 1_000_000_000n, effectiveSizeQ: 1_000_000_000n, entryE6: 400_000n, initialMarginBps: 1000n,
  initialMarkE6: 500_000n,
};

describe("dialog keyboard focus", () => {
  it("Add Margin: focus moves in, Tab stays inside, closing returns focus to the opener", () => {
    const { opener, close } = openFrom(<AddMarginModal slabAddress="s" userIdx={1} symbol="SOL" decimals={6} onClose={() => {}} />);
    expectFocusTrapped(screen.getByRole("dialog"));
    close();
    expect(document.activeElement).toBe(opener);
  });

  it("Share PnL: focus moves in, Tab stays inside, closing returns focus to the opener", () => {
    const { opener, close } = openFrom(<PnlShareModal data={PNL} onClose={() => {}} />);
    expectFocusTrapped(screen.getByRole("dialog", { name: "Share your PnL" }));
    close();
    expect(document.activeElement).toBe(opener);
  });

  it("Oracle details: focus moves in, Tab stays inside, closing returns focus to the opener", () => {
    const { opener, close } = openFrom(<OracleDetailsPanel onClose={() => {}} />);
    expectFocusTrapped(screen.getByRole("dialog", { name: "Oracle details" }));
    close();
    expect(document.activeElement).toBe(opener);
  });

  it("Fund your account (always mounted, shows itself): focus moves in when it shows", () => {
    faucet.shouldShow = false;
    const { rerender } = render(<DevnetFaucetModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
    faucet.shouldShow = true;
    rerender(<DevnetFaucetModal />);
    expectFocusTrapped(screen.getByRole("dialog", { name: "Fund your devnet account" }));
  });
});

describe("the trap and what is stacked on it", () => {
  it("Tab inside a dialog stacked on top (the wallet's signing prompt) is left to it", () => {
    render(<AddMarginModal slabAddress="s" userIdx={1} symbol="SOL" decimals={6} onClose={() => {}} />);
    const wallet = document.createElement("div"); // e.g. Privy's in-page dialog, outside Add Margin
    wallet.innerHTML = "<button>approve</button><button>reject</button>";
    document.body.appendChild(wallet);
    const approve = wallet.querySelector("button")!;
    approve.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false); // the browser moves on to "reject"
    expect(document.activeElement).toBe(approve);
    wallet.remove();
  });

  it("focus dropped to <body> (e.g. the focused button turned disabled) is still pulled back in", () => {
    render(<AddMarginModal slabAddress="s" userIdx={1} symbol="SOL" decimals={6} onClose={() => {}} />);
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("Oracle details renders a desktop and a mobile copy: focus goes to the one on screen", () => {
    // jsdom lays nothing out; give only the mobile sheet (the lg:hidden copy) a box.
    const spy = vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      const shown = !!this.closest("[class*='lg:hidden']") && !this.closest("[class*='max-lg:hidden']");
      return (shown ? [{}] : []) as unknown as DOMRectList;
    });
    render(<OracleDetailsPanel onClose={() => {}} />);
    const focused = document.activeElement as HTMLElement;
    spy.mockRestore();
    expect(focused.closest("[class*='max-lg:hidden']")).toBeNull();
    expect(focused.closest("[class*='lg:hidden']")).not.toBeNull();
  });
});

describe("Add Margin", () => {
  it("Escape closes it, and its amount field is labelled", () => {
    const onClose = vi.fn();
    render(<AddMarginModal slabAddress="s" userIdx={1} symbol="SOL" decimals={6} onClose={onClose} />);
    expect(screen.getByLabelText("Amount (SOL)")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("while the deposit is in flight neither Escape, a backdrop click nor x closes it", () => {
    dep.loading = true;
    const onClose = vi.fn();
    render(<AddMarginModal slabAddress="s" userIdx={1} symbol="SOL" decimals={6} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    const scrim = screen.getByRole("dialog").parentElement!;
    fireEvent.click(scrim);
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("is portaled to <body> above the page chrome (the shared Modal's z-tier)", () => {
    const { container } = render(<AddMarginModal slabAddress="s" userIdx={1} symbol="SOL" decimals={6} onClose={() => {}} />);
    const scrim = screen.getByRole("dialog").parentElement!;
    expect(container.contains(scrim)).toBe(false);
    expect(scrim).toHaveClass("z-[9999]");
  });
});
