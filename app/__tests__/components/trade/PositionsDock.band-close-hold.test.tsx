/**
 * GAP-12: while the band refuses the favourable close (104), the dock says so in plain view (not only a tooltip), with the time
 * estimated from the market's own gap and per-sweep walk. A market that is not lagging shows nothing.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ account: null as unknown, band: null as unknown }));
const OWNER = new PublicKey("11111111111111111111111111111111");

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.account, useUserAccountScanPending: () => false }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));
vi.mock("@/hooks/useBandRentView", () => ({ useBandRentView: () => h.band }));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: async () => {}, loading: false, error: null, phase: "idle", lastSig: null, resetPhase: () => {}, prewarmClose: () => {} }),
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
import { seedLotExp0 } from "../../helpers/v22-fixtures";

seedLotExp0();

const band = (lagging: boolean, favourableCloseSide: "long" | "short" | null) => ({
  assetIndex: 0,
  lotExp: 0,
  band: { enabled: true, bandBps: 130, epochSlots: 0n, pinSlots: 0n, maxPositionsPerSide: 0, minLegNotionalAtoms: 0n, recoveryMinutes: 0 },
  price: { capBpsPerSlot: 4n, markE6: 100_000_000n, targetE6: 109_000_000n, lagging, floorStuck: false, favourableCloseSide },
  rent: { enabled: false, maxE9PerSlot: 0n, kinkBps: 0, rateLongE9: 0n, rateShortE9: 0n },
});

beforeEach(() => {
  localStorage.clear();
  h.band = null;
  h.account = {
    idx: 0, pubkey: OWNER,
    account: { kind: 0, owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 40_000_000n, entryPrice: 0n, adlABasis: 1_000_000_000_000_000n, reservedPnl: 0n, feeCredits: 0n },
  };
});

describe("PositionsDock: close on hold while the band catches up", () => {
  it("long position, long-side close refused: visible calm line with a time, Close disabled with the same line", () => {
    h.band = band(true, "long");
    render(<PositionsDock slabAddress="s" />);
    const note = screen.getByTestId("band-close-on-hold");
    // 900 bps gap, min(4 x 26, 130) = 104 per sweep -> 9 sweeps x 26 slots x 400 ms = 93.6 s -> "about 2 minutes".
    expect(note).toHaveTextContent("The price is still catching up after a big move. Closing is available in about 2 minutes.");
    expect(note.textContent).not.toMatch(/second/i);
    const btn = screen.getByTestId("position-close");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", note.textContent ?? "");
  });
  it("NEGATIVE CONTROL: not lagging, or the other side is the favourable one -> no note, Close enabled", () => {
    h.band = band(false, null);
    const { unmount } = render(<PositionsDock slabAddress="s" />);
    expect(screen.queryByTestId("band-close-on-hold")).toBeNull();
    expect(screen.getByTestId("position-close")).toBeEnabled();
    unmount();
    h.band = band(true, "short");
    render(<PositionsDock slabAddress="s" />);
    expect(screen.queryByTestId("band-close-on-hold")).toBeNull();
    expect(screen.getByTestId("position-close")).toBeEnabled();
  });
});
