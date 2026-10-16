/**
 * A sub-cent PnL on a sub-cent token read "$0.00" and never changed: the dock's USD line was
 * `toFixed(2)`. 3,000 JEANPHIL short, entry $0.004694, mark $0.004693 = +$0.003, which must show.
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
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: h.priceE6, priceUsd: h.priceE6 === null ? null : Number(h.priceE6) / 1e6 }) }));
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

beforeEach(() => {
  localStorage.clear();
});

describe("PositionsDock USD line under a cent", () => {
  it("a +$0.003 short on a $0.0047 token shows its amount, not $0.00", () => {
    h.priceE6 = 4_693n;
    h.account = acct({ positionSize: -3_000_000_000n, capital: 1_000_000_000n });
    saveEntryPrice("s", 0, 4_694n, -4, OWNER.toBase58());
    const { container } = render(<PositionsDock slabAddress="s" />);
    const text = container.textContent ?? "";
    expect(text).toContain("+$0.0030");
    expect(text).not.toMatch(/\$0\.00(?!\d)/);
  });

  it("a real zero still reads $0.00", () => {
    h.priceE6 = 4_694n;
    h.account = acct({ positionSize: -3_000_000_000n, capital: 1_000_000_000n });
    saveEntryPrice("s", 0, 4_694n, -4, OWNER.toBase58());
    const { container } = render(<PositionsDock slabAddress="s" />);
    expect(container.textContent ?? "").toContain("$0.00");
  });
});
