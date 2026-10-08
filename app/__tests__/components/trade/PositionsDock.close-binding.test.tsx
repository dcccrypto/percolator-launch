/**
 * #3301: the dock's Close acts on the portfolio account the row was drawn from (the pubkey of the
 * account the row shows), for the modal's prewarm and for the confirm.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ account: null as unknown }));
const ROW_PK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const OWNER = new PublicKey("11111111111111111111111111111111");

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.account, useUserAccountScanPending: () => false }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));
const closePosition = vi.fn(async () => ({ signature: "sig" }));
const prewarmClose = vi.fn();
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition, loading: false, error: null, phase: "idle", lastSig: null, resetPhase: () => {}, prewarmClose }),
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
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 100_000_000n, priceUsd: 100 }) }));
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
vi.mock("@/components/trade/PositionNftMenu", () => ({ PositionNftMenu: () => null, ClosedPositionNftNotice: () => null, NFT_MENU_COPY: { badge: "NFT", closeWrapped: "Unwrap to close this position" } }));

import { PositionsDock } from "@/components/trade/PositionsDock";

beforeEach(() => {
  closePosition.mockClear();
  prewarmClose.mockClear();
  localStorage.clear();
  h.account = {
    idx: 0, pubkey: ROW_PK,
    account: { kind: 0, owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 40_000_000n, entryPrice: 0n, adlABasis: 1_000_000_000_000_000n, reservedPnl: 0n, feeCredits: 0n },
  };
});


describe("PositionsDock Close binds the row's own account (#3301)", () => {
  it("opening the modal prewarms, and confirming closes, exactly the account the row shows", async () => {
    render(<PositionsDock slabAddress="s" />);
    fireEvent.click(screen.getByTestId("position-close"));
    expect(prewarmClose).toHaveBeenCalledWith({ portfolioPk: ROW_PK });
    await act(async () => { fireEvent.click(screen.getByTestId("close-confirm")); });
    expect(closePosition).toHaveBeenCalledTimes(1);
    const [percent, opts] = closePosition.mock.calls[0] as unknown as [number, { portfolioPk: PublicKey }];
    expect(percent).toBe(100);
    expect(opts.portfolioPk.equals(ROW_PK)).toBe(true);
  });
});
