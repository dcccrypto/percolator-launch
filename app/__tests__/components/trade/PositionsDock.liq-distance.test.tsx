/**
 * The dock's liquidation cell says how far the mark is from a real liquidation
 * price ("5.3% to liq"), with the same directional distance as the portfolio
 * card. The "% mgn" (covered) and unknown cells stay as they were: no distance
 * is printed where there is no price or no mark.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  account: null as unknown,
  priceE6: 100_000_000n as bigint | null,
}));

const OWNER = new PublicKey("11111111111111111111111111111111");
const acct = (over: Record<string, unknown>) => ({
  idx: 0,
  pubkey: OWNER,
  account: {
    kind: 0, owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 40_000_000n,
    entryPrice: 0n, adlABasis: 1_000_000_000_000_000n, reservedPnl: 0n, feeCredits: 0n,
    ...over,
  },
});

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.account, useUserAccountScanPending: () => false }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), loading: false, error: null, prewarmClose: vi.fn() }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    accounts: [],
    config: { collateralMint: OWNER, lastEffectivePriceE6: 100_000_000n, invert: 0 },
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: h.priceE6, priceUsd: 100 }) }));
vi.mock("@/hooks/useMarketConfig", () => ({ useMarketConfig: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP" } }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, insuranceBalance: 0n }) }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => ({ maxFillAbs: null }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh", mode: "keeper", ready: true }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => null }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccount: () => null }));
vi.mock("@/components/dev/RenderProfiler", () => ({ RenderProfiler: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/trade/OtherMarketPositions", () => ({ OtherMarketPositions: () => null }));
vi.mock("@/components/trade/TradeHistory", () => ({ TradeHistory: () => null }));
vi.mock("@/components/trade/WarmupProgress", () => ({ WarmupProgress: () => null }));
vi.mock("@/components/trade/ClosePositionModal", () => ({ ClosePositionModal: () => null }));
vi.mock("@/components/trade/PositionNftMenu", () => ({ PositionNftMenu: () => <span data-testid="nft-menu-marker" />, ClosedPositionNftNotice: () => <span data-testid="closed-nft-marker" />, NFT_MENU_COPY: { badge: "NFT", closeWrapped: "Unwrap to close this position" } }));

import { PositionsDock } from "@/components/trade/PositionsDock";
import { saveEntryPrice } from "@/lib/entry-price";

const E6 = 1_000_000n;
beforeEach(() => {
  localStorage.clear();
  // 10x long: 1 unit at $100 on 10 USDC (mm 5% / im 10%) -> engine liq $94.74.
  h.account = acct({ capital: 10n * E6, positionSize: 1n * E6 });
  saveEntryPrice("s", 0, 100n * E6, 10, OWNER.toBase58());
});

const liq = () => screen.getByTestId("position-liq");
const distance = () => screen.queryByTestId("position-liq-distance");

describe("PositionsDock liquidation distance", () => {
  it("long: shows the distance from the mark down to the liquidation price", () => {
    h.priceE6 = 100n * E6;
    render(<PositionsDock slabAddress="s" />);
    expect(liq().textContent).toMatch(/94\.7/);
    // (100 - 94.74) / 100
    expect(distance()).toHaveTextContent("5.3% to liq");
  });

  it("short: shows the distance from the mark up to the liquidation price", () => {
    h.account = acct({ capital: 10n * E6, positionSize: -1n * E6 });
    h.priceE6 = 100n * E6;
    render(<PositionsDock slabAddress="s" />);
    // engine liq (100 + 10) / 1.05 = 104.76; (104.76 - 100) / 104.76, the shared helper's short denominator
    expect(liq().textContent).toMatch(/104\.76/);
    expect(distance()).toHaveTextContent("4.5% to liq");
  });

  it("follows the live mark", () => {
    h.priceE6 = 97n * E6;
    render(<PositionsDock slabAddress="s" />);
    // (97 - 94.74) / 97
    expect(distance()).toHaveTextContent("2.3% to liq");
  });

  it("no distance under the covered '% mgn' cell", () => {
    h.account = acct({ capital: 200n * E6, positionSize: 1n * E6 });
    h.priceE6 = 100n * E6;
    render(<PositionsDock slabAddress="s" />);
    expect(liq().textContent).toMatch(/% mgn/);
    expect(distance()).toBeNull();
  });

  it("no distance when there is no mark price", () => {
    h.priceE6 = null;
    render(<PositionsDock slabAddress="s" />);
    expect(distance()).toBeNull();
  });
});
