/**
 * "// other markets" rows show the same "x% to liq" line as the current
 * market's row, under a real liquidation price only.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioPosition } from "@/hooks/usePortfolio";

const h = vi.hoisted(() => ({ positions: [] as unknown[] }));

vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), loading: false, error: null, resetPhase: vi.fn(), prewarmClose: vi.fn() }),
}));
vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: () => ({ connected: true }) }));
vi.mock("@/hooks/usePortfolio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/usePortfolio")>()),
  usePortfolio: () => ({ positions: h.positions, refresh: () => {} }),
}));
vi.mock("@/hooks/useMultiTokenMeta", () => ({ useMultiTokenMeta: () => new Map() }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh", mode: "keeper", ready: true }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSlabState: () => ({ params: null }),
}));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));

import { OtherMarketPositions } from "@/components/trade/OtherMarketPositions";
import { getMockPortfolioPositions } from "@/lib/mock-trade-data";

const E6 = 1_000_000n;
/** One position on another market, priced off the poll's oracle mark (no live tick in tests). */
function position(over: { size: bigint; capital: bigint; markE6: bigint; liqE6: bigint }): PortfolioPosition {
  const base = getMockPortfolioPositions()[0];
  return {
    ...base,
    slabAddress: "other-slab",
    effectiveSize: over.size,
    oraclePriceE6: over.markE6,
    effectiveEntryPrice: over.markE6,
    liquidationPriceE6: over.liqE6,
    maintenanceMarginBps: 500n,
    account: { ...base.account, positionSize: over.size, capital: over.capital, pnl: 0n },
  };
}

const distance = () => screen.queryByTestId("position-liq-distance");

beforeEach(() => { h.positions = []; });

describe("OtherMarketPositions liquidation distance", () => {
  it("long: (mark - liq) / mark under the price", () => {
    h.positions = [position({ size: 1n * E6, capital: 10n * E6, markE6: 100n * E6, liqE6: 95n * E6 })];
    render(<OtherMarketPositions currentSlab="this-slab" />);
    expect(distance()).toHaveTextContent("5.0% to liq");
  });

  it("short: (liq - mark) / liq under the price", () => {
    h.positions = [position({ size: -1n * E6, capital: 10n * E6, markE6: 100n * E6, liqE6: 110n * E6 })];
    render(<OtherMarketPositions currentSlab="this-slab" />);
    // (110 - 100) / 110 = 9.09%: the shared helper measures a short against the liq price
    expect(distance()).toHaveTextContent("9.1% to liq");
  });

  it("no distance under the covered '% mgn' cell", () => {
    h.positions = [position({ size: 1n * E6, capital: 200n * E6, markE6: 100n * E6, liqE6: 0n })];
    render(<OtherMarketPositions currentSlab="this-slab" />);
    expect(screen.getByText(/% mgn/)).toBeInTheDocument();
    expect(distance()).toBeNull();
  });

  it("no distance when there is no mark price", () => {
    h.positions = [position({ size: 1n * E6, capital: 10n * E6, markE6: 0n, liqE6: 95n * E6 })];
    render(<OtherMarketPositions currentSlab="this-slab" />);
    expect(screen.getByText(/\$95/)).toBeInTheDocument();
    expect(distance()).toBeNull();
  });
});
