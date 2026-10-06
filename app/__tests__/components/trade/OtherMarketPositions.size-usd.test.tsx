/**
 * "// other markets" rows add the position's USD value at the mark under the
 * base-unit size, like the current market's row; nothing without a mark.
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
function position(size: bigint, markE6: bigint): PortfolioPosition {
  const base = getMockPortfolioPositions()[0];
  return {
    ...base,
    slabAddress: "other-slab",
    effectiveSize: size,
    oraclePriceE6: markE6,
    account: { ...base.account, positionSize: size },
  };
}

const sizeUsd = () => screen.queryByTestId("position-size-usd");

beforeEach(() => { h.positions = []; });

describe("OtherMarketPositions size in USD", () => {
  it("values the size at the mark: 2.5 units @ $40", () => {
    h.positions = [position(2_500_000n, 40n * E6)];
    render(<OtherMarketPositions currentSlab="this-slab" />);
    expect(sizeUsd()).toHaveTextContent("≈ $100.00");
  });

  it("a short's value is its magnitude", () => {
    h.positions = [position(-2_500_000n, 40n * E6)];
    render(<OtherMarketPositions currentSlab="this-slab" />);
    expect(sizeUsd()).toHaveTextContent("≈ $100.00");
  });

  it("no USD line without a mark", () => {
    h.positions = [position(2_500_000n, 0n)];
    render(<OtherMarketPositions currentSlab="this-slab" />);
    expect(sizeUsd()).toBeNull();
  });
});
