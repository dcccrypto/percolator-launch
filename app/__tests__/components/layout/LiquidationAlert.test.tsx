/**
 * Site-wide liquidation warning: open positions within 20% of liquidation (at the live mark)
 * show on every page but /portfolio, with Go to market and Close. Close only opens the
 * confirm modal; nothing is sent until the user confirms there (and then in the wallet).
 */
import "@testing-library/jest-dom";
import { act } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { AccountKind } from "@percolatorct/sdk";
import { applyOnChainPoll } from "@/lib/priceStore/priceStore";

const h = vi.hoisted(() => ({
  pathname: "/markets",
  connected: true,
  positions: [] as unknown[],
  closePosition: vi.fn(),
  // Runs once per mount of the close flow (CloseFlow's effect); a remount would call it again.
  prewarm: vi.fn(),
}));

vi.mock("next/link", () => ({ default: ({ children, href, className }: any) => <a href={href} className={className}>{children}</a> }));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname }));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ connected: h.connected, publicKey: null }) }));
vi.mock("@/hooks/usePortfolio", async (io) => ({
  ...(await io<typeof import("@/hooks/usePortfolio")>()),
  usePortfolio: () => ({ positions: h.positions, refresh: vi.fn(), loading: false }),
}));
vi.mock("@/hooks/useMultiTokenMeta", () => ({ useMultiTokenMeta: () => new Map() }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: any) => <>{children}</>,
  useSlabState: () => ({}),
}));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: h.closePosition, loading: false, error: null, prewarmClose: h.prewarm }),
}));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh", mode: "auth", ready: true }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));

import { LiquidationAlert } from "@/components/layout/LiquidationAlert";
import { AtRiskBanner } from "@/components/portfolio/AtRiskBanner";

const pk = new PublicKey("11111111111111111111111111111111");
// Long at 100 with liquidation at 85: 15% away (warning).
const row = (slab: string, symbol: string, over: Record<string, unknown> = {}) => ({
  slabAddress: slab, symbol, idx: 0, collateralMint: pk, nftWrapped: false,
  account: { kind: AccountKind.User, owner: pk, capital: 1_000_000n, positionSize: 5_000_000n, pnl: 0n, entryPrice: 100_000_000n },
  effectiveEntryPrice: 100_000_000n, entryPriceSource: "cache", effectiveSize: 5_000_000n,
  unrealizedPnl: 0n, oraclePriceE6: 100_000_000n, pnlPercent: 0, leverage: 5, initialMarginBps: 1000n, maintenanceMarginBps: 500n,
  liquidationPriceE6: 85_000_000n, liquidationDistancePct: 15,
  ...over,
});
const alertBox = () => screen.queryByRole("complementary", { name: "Positions near liquidation" });

beforeEach(() => {
  h.pathname = "/markets";
  h.connected = true;
  h.closePosition.mockReset();
  h.prewarm.mockReset();
  try { sessionStorage.clear(); } catch { /* none */ }
});

describe("LiquidationAlert", () => {
  it("lists an at-risk position with its distance, Go to market and Close", () => {
    h.positions = [row("SlabA1111", "SOL"), row("SlabSafe111", "JUP", { liquidationPriceE6: 50_000_000n, liquidationDistancePct: 50 })];
    render(<LiquidationAlert />);
    const box = alertBox()!;
    expect(within(box).getByText("SOL")).toBeInTheDocument();
    expect(within(box).getByText("15.0%")).toBeInTheDocument();
    expect(within(box).queryByText("JUP")).toBeNull(); // 50% away: not shown
    expect(within(box).getByRole("link", { name: "Go to market" })).toHaveAttribute("href", "/trade/SlabA1111");
    expect(within(box).getByRole("button", { name: "Close position" })).toBeInTheDocument();
  });

  it("Close only opens the confirm modal; nothing closes until Confirm", () => {
    h.positions = [row("SlabA2222", "SOL")];
    render(<LiquidationAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Close position" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(h.closePosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("close-cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(h.closePosition).not.toHaveBeenCalled();
  });

  it("is hidden on /portfolio, which shows the same rows inline", () => {
    h.positions = [row("SlabA3333", "SOL")];
    h.pathname = "/portfolio";
    render(<LiquidationAlert />);
    expect(alertBox()).toBeNull();
  });

  it("renders nothing with no wallet connected", () => {
    h.positions = [row("SlabA4444", "SOL")];
    h.connected = false;
    render(<LiquidationAlert />);
    expect(alertBox()).toBeNull();
  });

  it("Hide keeps it hidden at the same tier, and it comes back when it gets worse", () => {
    const slab = "SlabA5555";
    h.positions = [row(slab, "SOL")];
    render(<LiquidationAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Hide the warning for SOL" }));
    expect(alertBox()).toBeNull();
    act(() => applyOnChainPoll(slab, 97_000_000n)); // (97 - 85) / 97 = 12.4%: still a warning
    expect(alertBox()).toBeNull();
    act(() => applyOnChainPoll(slab, 89_000_000n)); // (89 - 85) / 89 = 4.49%: danger
    const box = alertBox()!;
    expect(within(box).getByText("4.5%")).toBeInTheDocument();
    expect(within(box).getByText("Liquidation risk")).toBeInTheDocument();
    expect(within(box).getByRole("alert")).toHaveTextContent("1 position at liquidation risk");
  });

  it("a hidden position alerts again after leaving the range and coming back", () => {
    const slab = "SlabA7777";
    h.positions = [row(slab, "SOL")];
    render(<LiquidationAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Hide the warning for SOL" }));
    expect(alertBox()).toBeNull();
    act(() => applyOnChainPoll(slab, 120_000_000n)); // (120 - 85) / 120 = 29%: out of range
    act(() => applyOnChainPoll(slab, 100_000_000n)); // back to 15%
    expect(within(alertBox()!).getByText("15.0%")).toBeInTheDocument();
  });

  it("a Hide is not forgotten while the price hovers at the warning line", () => {
    const slab = "SlabA8888";
    h.positions = [row(slab, "SOL")];
    render(<LiquidationAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Hide the warning for SOL" }));
    act(() => applyOnChainPoll(slab, 107_000_000n)); // (107 - 85) / 107 = 20.6%: just out of range
    act(() => applyOnChainPoll(slab, 105_000_000n)); // 19.0%: back in
    expect(alertBox()).toBeNull();
  });

  it("two positions on one market are hidden separately", () => {
    h.positions = [
      row("SlabA9999", "SOL", { nftWrapped: true }),
      row("SlabA9999", "SOL", { nftWrapped: true, liquidationPriceE6: 95_000_000n,
        account: { kind: AccountKind.User, owner: pk, capital: 1_000_000n, positionSize: 3_000_000n, pnl: 0n, entryPrice: 100_000_000n } }),
    ];
    render(<LiquidationAlert />);
    expect(within(alertBox()!).getAllByText("SOL")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Hide the warning for SOL" })[0]);
    const left = within(alertBox()!).getAllByText("SOL");
    expect(left).toHaveLength(1);
    expect(within(alertBox()!).getByText("15.0%")).toBeInTheDocument(); // the 5% one was hidden
  });

  it("the close window stays open when the position moves out of range", () => {
    const slab = "SlabB1111";
    h.positions = [row(slab, "SOL")];
    render(<LiquidationAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Close position" }));
    act(() => applyOnChainPoll(slab, 130_000_000n)); // (130 - 85) / 130 = 34.6%: out of range
    expect(alertBox()).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Same instance: a remount would reset useClosePosition's in-flight guard mid-close.
    expect(h.prewarm).toHaveBeenCalledTimes(1);
    expect(h.closePosition).not.toHaveBeenCalled();
  });

  it("Hide holds across polls for a position whose entry price is not known", () => {
    // "unknown" entry: the poll fills in its own mark, so it changes every poll.
    h.positions = [row("SlabB2222", "SOL", { entryPriceSource: "unknown", effectiveEntryPrice: 100_000_000n })];
    const { rerender } = render(<LiquidationAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Hide the warning for SOL" }));
    h.positions = [row("SlabB2222", "SOL", { entryPriceSource: "unknown", effectiveEntryPrice: 100_400_000n })];
    rerender(<LiquidationAlert />);
    expect(alertBox()).toBeNull();
  });

  it("a wrapped position offers Go to market but no Close", () => {
    h.positions = [row("SlabA6666", "SOL", { nftWrapped: true })];
    render(<LiquidationAlert />);
    const box = alertBox()!;
    expect(within(box).getByRole("link", { name: "Go to market" })).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: "Close position" })).toBeNull();
  });

  it("shows the closest first and points to Portfolio for the rest", () => {
    h.positions = ["S1", "S2", "S3", "S4", "S5"].map((s, i) =>
      row(`Slab${s}xxxx`, s, { liquidationPriceE6: BigInt(81_000_000 + i * 2_000_000) }),
    );
    render(<LiquidationAlert />);
    const box = alertBox()!;
    const names = within(box).getAllByText(/^S\d$/).map((n) => n.textContent);
    expect(names).toEqual(["S5", "S4", "S3"]); // 11%, 13%, 15%: closest first
    expect(within(box).getByText("+2 more on Portfolio")).toBeInTheDocument();
  });
});

describe("AtRiskBanner close flow", () => {
  it("stays the same open modal when the position leaves the list", () => {
    const p = row("SlabB3333", "SOL") as any;
    const { rerender } = render(<AtRiskBanner positions={[p]} livePrices={new Map()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close position" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Recovers to 35%: the strip empties, the modal must not remount.
    rerender(<AtRiskBanner positions={[p]} livePrices={new Map([["SlabB3333", 130_000_000n]])} />);
    expect(screen.queryByRole("region", { name: "Positions near liquidation" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(h.prewarm).toHaveBeenCalledTimes(1);
    expect(h.closePosition).not.toHaveBeenCalled();
  });
});
