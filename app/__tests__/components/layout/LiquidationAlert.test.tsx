/**
 * Site-wide liquidation warning: open positions that have used half or more of their margin
 * cushion (at the live mark, engine maintenance model) show on every page but /portfolio,
 * with Go to market and Close. Close only opens the
 * confirm modal; nothing is sent until the user confirms there (and then in the wallet).
 */
import "@testing-library/jest-dom";
import { act } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { AccountKind } from "@percolatorct/sdk";
import { applyOnChainPoll } from "@/lib/priceStore/priceStore";
import { computeLiqPrice } from "@/lib/trading";
import { computeLiquidationDistancePct } from "@/lib/liquidation-distance";

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
const E6 = 1_000_000n;
/**
 * A 10x long (1 unit at $100, 10 USDC, mm 5% / im 10%). Engine liquidation price 94.7368.
 * Margin cushion left at a mark P: ((10 + P - 100)/P - 5%) / 5%.
 *   mark 100  -> 1.00 safe        mark 97   -> 0.44 warning, 2.3% from liquidation
 *   mark 98.8 -> 0.82 (forgets)   mark 97.6 -> 0.56 safe, but a Hide holds
 *   mark 95.8 -> 0.21 danger, 1.1% from liquidation
 * liquidationPriceE6 comes from the real (engine) computeLiqPrice, as usePortfolio derives it.
 */
const row = (slab: string, symbol: string, over: Record<string, unknown> = {}, opts: { mark?: bigint; capital?: bigint; size?: bigint; entry?: bigint } = {}) => {
  const mark = opts.mark ?? 97n * E6;
  const capital = opts.capital ?? 10n * E6;
  const size = opts.size ?? 1n * E6;
  const entry = opts.entry ?? 100n * E6;
  const liq = computeLiqPrice(entry, capital, size, 500n);
  return {
    slabAddress: slab, symbol, idx: 0, collateralMint: pk, nftWrapped: false,
    account: { kind: AccountKind.User, owner: pk, capital, positionSize: size, pnl: 0n, entryPrice: entry },
    effectiveEntryPrice: entry, entryPriceSource: "cache", effectiveSize: size,
    unrealizedPnl: 0n, oraclePriceE6: mark, pnlPercent: 0, leverage: 10, initialMarginBps: 1000n, maintenanceMarginBps: 500n,
    liquidationPriceE6: liq, liquidationDistancePct: computeLiquidationDistancePct(size, mark, liq),
    ...over,
  };
};
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
    h.positions = [row("SlabA1111", "SOL"), row("SlabSafe111", "JUP", {}, { mark: 100n * E6 })];
    render(<LiquidationAlert />);
    const box = alertBox()!;
    expect(within(box).getByText("SOL")).toBeInTheDocument();
    expect(within(box).getByText("2.3%")).toBeInTheDocument(); // to the engine's 94.74, not the SDK's 90.48
    expect(within(box).queryByText("JUP")).toBeNull(); // a fresh 10x position: not an alert
    expect(within(box).getByRole("link", { name: "Go to market" })).toHaveAttribute("href", "/trade/SlabA1111");
    expect(within(box).getByRole("button", { name: "Close position" })).toBeInTheDocument();
  });

  it("a freshly opened position does not alert at any leverage up to the market's 10x (#2987)", () => {
    // The old flat 20%/10% tiers showed an amber card for every position of ~4.2x+ the moment
    // it opened, and a red one from ~6.9x.
    h.positions = [2n, 5n, 7n, 10n].flatMap((lev) => [
      row(`SlabFreshL${lev}`, `L${lev}`, {}, { mark: 100n * E6, capital: (100n * E6) / lev }),
      row(`SlabFreshS${lev}`, `S${lev}`, { effectiveSize: -1n * E6 }, { mark: 100n * E6, capital: (100n * E6) / lev, size: -1n * E6 }),
    ]);
    render(<LiquidationAlert />);
    expect(alertBox()).toBeNull();
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

  it("on /trade at lg+ the card is a compact pill in the dock row, not a card over the chart or ticket", () => {
    h.pathname = "/trade/SlabTrade111";
    h.positions = [row("SlabA1112", "SOL")];
    render(<LiquidationAlert />);
    const cls = alertBox()!.className;
    expect(cls).toContain("lg:hidden"); // collapsed at lg+
    expect(cls).not.toContain("lg:left-5");
    expect(cls).not.toContain("lg:right-5");
    const pill = screen.getByTestId("liq-alert-pill");
    expect(pill.className).toContain("bottom-1");
    expect(pill.className).toContain("lg:flex");
    expect(pill).toHaveAttribute("aria-expanded", "false");
  });

  it("the pill opens the full card above the dock row, and again closes it", () => {
    h.pathname = "/trade/SlabTrade111";
    h.positions = [row("SlabA1113", "SOL")];
    render(<LiquidationAlert />);
    fireEvent.click(screen.getByTestId("liq-alert-pill"));
    expect(screen.getByTestId("liq-alert-pill")).toHaveAttribute("aria-expanded", "true");
    expect(alertBox()!.className).not.toContain("lg:hidden");
    expect(alertBox()!.className).toContain("lg:bottom-11");
    fireEvent.click(screen.getByTestId("liq-alert-pill"));
    expect(alertBox()!.className).toContain("lg:hidden");
  });

  it("off /trade the placement is unchanged (no lg override)", () => {
    h.pathname = "/markets";
    h.positions = [row("SlabA1114", "SOL")];
    render(<LiquidationAlert />);
    expect(screen.queryByTestId("liq-alert-pill")).toBeNull();
    const cls = alertBox()!.className;
    expect(cls).toContain("md:right-5");
    expect(cls).not.toContain("lg:");
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
    act(() => applyOnChainPoll(slab, 96_900_000n)); // cushion 0.42: still a warning
    expect(alertBox()).toBeNull();
    act(() => applyOnChainPoll(slab, 95_800_000n)); // cushion 0.21: danger
    const box = alertBox()!;
    expect(within(box).getByText("1.1%")).toBeInTheDocument();
    expect(within(box).getByText("Liquidation risk")).toBeInTheDocument();
    expect(within(box).getByRole("alert")).toHaveTextContent("1 position at liquidation risk");
  });

  it("a hidden position alerts again after leaving the range and coming back", () => {
    const slab = "SlabA7777";
    h.positions = [row(slab, "SOL")];
    render(<LiquidationAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Hide the warning for SOL" }));
    expect(alertBox()).toBeNull();
    act(() => applyOnChainPoll(slab, 98_800_000n)); // cushion 0.82: clearly out of range
    act(() => applyOnChainPoll(slab, 97_000_000n)); // back to 0.44
    expect(within(alertBox()!).getByText("2.3%")).toBeInTheDocument();
  });

  it("a Hide is not forgotten while the price hovers at the warning line", () => {
    const slab = "SlabA8888";
    h.positions = [row(slab, "SOL")];
    render(<LiquidationAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Hide the warning for SOL" }));
    act(() => applyOnChainPoll(slab, 97_600_000n)); // cushion 0.56: just out of range
    act(() => applyOnChainPoll(slab, 97_000_000n)); // 0.44: back in
    expect(alertBox()).toBeNull();
  });

  it("two positions on one market are hidden separately", () => {
    h.positions = [
      row("SlabA9999", "SOL", { nftWrapped: true }),
      // 3 units, same 10x, polled at 95.8: danger, so it sorts first
      row("SlabA9999", "SOL", { nftWrapped: true }, { size: 3n * E6, capital: 30n * E6, mark: 95_800_000n }),
    ];
    render(<LiquidationAlert />);
    expect(within(alertBox()!).getAllByText("SOL")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Hide the warning for SOL" })[0]);
    const left = within(alertBox()!).getAllByText("SOL");
    expect(left).toHaveLength(1);
    expect(within(alertBox()!).getByText("2.3%")).toBeInTheDocument(); // the danger one was hidden
  });

  it("the close window stays open when the position moves out of range", () => {
    const slab = "SlabB1111";
    h.positions = [row(slab, "SOL")];
    render(<LiquidationAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Close position" }));
    act(() => applyOnChainPoll(slab, 101_000_000n)); // cushion 1.1: out of range
    expect(alertBox()).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Same instance: a remount would reset useClosePosition's in-flight guard mid-close.
    expect(h.prewarm).toHaveBeenCalledTimes(1);
    expect(h.closePosition).not.toHaveBeenCalled();
  });

  it("Hide holds across polls for a position whose entry price is not known", () => {
    // "unknown" entry: the poll fills in its own mark, so it changes every poll.
    // Entry = the poll's mark, 7 USDC on a $100 notional: 7% equity, judged against the 10%
    // initial-margin line -> cushion 0.4, a warning.
    h.positions = [row("SlabB2222", "SOL", { entryPriceSource: "unknown" }, { mark: 100n * E6, entry: 100n * E6, capital: 7n * E6 })];
    const { rerender } = render(<LiquidationAlert />);
    fireEvent.click(screen.getByRole("button", { name: "Hide the warning for SOL" }));
    h.positions = [row("SlabB2222", "SOL", { entryPriceSource: "unknown" }, { mark: 100n * E6, entry: 100_400_000n, capital: 7n * E6 })];
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
      row(`Slab${s}xxxx`, s, {}, { mark: BigInt(97_000_000 - i * 200_000) }), // all warnings, S5 closest
    );
    render(<LiquidationAlert />);
    const box = alertBox()!;
    const names = within(box).getAllByText(/^S\d$/).map((n) => n.textContent);
    expect(names).toEqual(["S5", "S4", "S3"]); // closest first
    expect(within(box).getByText("+2 more on Portfolio")).toBeInTheDocument();
  });
});

describe("AtRiskBanner close flow", () => {
  it("stays the same open modal when the position leaves the list", () => {
    const p = row("SlabB3333", "SOL") as any;
    const { rerender } = render(<AtRiskBanner positions={[p]} livePrices={new Map()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close position" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    // Recovers (cushion 1.1): the strip empties, the modal must not remount.
    rerender(<AtRiskBanner positions={[p]} livePrices={new Map([["SlabB3333", 101_000_000n]])} />);
    expect(screen.queryByRole("region", { name: "Positions near liquidation" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(h.prewarm).toHaveBeenCalledTimes(1);
    expect(h.closePosition).not.toHaveBeenCalled();
  });
});
