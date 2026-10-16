/**
 * Browser E2E 2026-10-16 (unlisted market 2xhs on the v2.2 preview): a market with no known symbol labelled its
 * position row "USDC/USD" with the size "0.190277 USDC": the collateral symbol, never the traded pair. The row now
 * names it like the trade header (truncated slab address) and the size in neutral "TOKEN".
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  account: null as unknown,
  priceE6: 100_000_000n as bigint | null,
  marketSymbol: null as string | null,
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
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: h.marketSymbol ? { symbol: h.marketSymbol } : null }) }));
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
  // 1 unit long at $100 on 10 USDC.
  h.account = acct({ capital: 10n * E6, positionSize: 1n * E6 });
  saveEntryPrice("2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw", 0, 100n * E6, 10, OWNER.toBase58());
});

const row = () => screen.getByTestId("position-row");

describe("PositionsDock market label without a known symbol", () => {
  it("an unlisted market reads as its slab address, its size in TOKEN; never USDC", () => {
    h.marketSymbol = null;
    render(<PositionsDock slabAddress="2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw" />);
    expect(row()).toHaveTextContent("2xhs…BzVw/USD");
    expect(row()).toHaveTextContent(/TOKEN/);
    expect(row()).not.toHaveTextContent("USDC/USD");
    expect(row()).not.toHaveTextContent(/LONG1USDC/); // the size is never in the collateral (PnL still is, correctly)
  });
  it("NEGATIVE CONTROL: a known market keeps its symbol (SOL-PERP -> SOL/USD, size in SOL)", () => {
    h.marketSymbol = "SOL-PERP";
    render(<PositionsDock slabAddress="2xhsLP9NLkUMMsCsyzkHM9R1zsVU2V2vDo6v9WuPBzVw" />);
    expect(row()).toHaveTextContent("SOL/USD");
    expect(row()).not.toHaveTextContent(/TOKEN|2xhs/);
  });
});
