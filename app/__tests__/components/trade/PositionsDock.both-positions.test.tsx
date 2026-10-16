/**
* Audit #40: wallet holds BOTH a normal and an NFT-wrapped position on
 * one market -> the dock must show both rows, and each row's ⋯ menu must be
 * bound to that row. Run against the CURRENT PositionsDock to prove it fails.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ account: null as unknown, wrapped: null as unknown, engineStale: false }));

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
// Faithful to the real hook's contract: `return enabled ? wrapped : null`.
vi.mock("@/hooks/useNftWrappedPosition", () => ({
  useNftWrappedPosition: (_slab: string, enabled: boolean) => (enabled ? h.wrapped : null),
}));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), loading: false, error: null, prewarmClose: vi.fn(), resetPhase: vi.fn() }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    accounts: [],
    config: { collateralMint: OWNER, lastEffectivePriceE6: 100_000_000n, invert: 0 },
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
    wrapperConfigV17: null,
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 100_000_000n, priceUsd: 100 }) }));
vi.mock("@/hooks/useMarketConfig", () => ({ useMarketConfig: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP" } }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, insuranceBalance: 0n }) }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => ({ maxFillAbs: null }) }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => ({ flags: { p3: false } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh", mode: "keeper", ready: true }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: h.engineStale }) }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => null }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccount: () => null }));
vi.mock("@/components/dev/RenderProfiler", () => ({ RenderProfiler: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/trade/OtherMarketPositions", () => ({ OtherMarketPositions: () => null }));
vi.mock("@/components/trade/TradeHistory", () => ({ TradeHistory: () => null }));
vi.mock("@/components/trade/WarmupProgress", () => ({ WarmupProgress: () => <span data-testid="warmup-progress" /> }));
vi.mock("@/components/trade/ClosePositionModal", () => ({ ClosePositionModal: () => null }));
vi.mock("@/components/trade/PositionNftMenu", () => ({
  PositionNftMenu: ({ row }: { row?: string }) => <span data-testid={`nft-menu-${row ?? "none"}`} />,
  ClosedPositionNftNotice: () => null,
  NFT_MENU_COPY: { badge: "NFT", closeWrapped: "Unwrap to close this position", wrappedHint: "hint" },
}));

import { PositionsDock } from "@/components/trade/PositionsDock";

beforeEach(() => {
  localStorage.clear();
  h.account = acct({}); // normal LONG 40
  h.wrapped = {         // plus a wrapped SHORT 20 on the same market
    ...acct({ positionSize: -20_000_000n, capital: 500_000_000n }),
    nftMint: OWNER,
    nftPda: OWNER,
  };
});

describe("dock with BOTH a normal and an NFT-wrapped position (finding #40)", () => {
  it("renders two rows: the owned one and the wrapped one", () => {
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getAllByTestId("position-row")).toHaveLength(2);
    expect(screen.getByTestId("position-nft-badge")).toBeInTheDocument();  // wrapped row badged
    expect(screen.getByTestId("position-close")).toBeInTheDocument();          // owned row closeable
    expect(screen.getByTestId("position-close-wrapped")).toBeInTheDocument();  // wrapped row not
  });
  it("each row's ⋯ menu is bound to that row", () => {
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getByTestId("nft-menu-own")).toBeInTheDocument();
    expect(screen.getByTestId("nft-menu-wrapped")).toBeInTheDocument();
  });
  it("CONTROL wrapped-only: exactly one (wrapped) row, no duplicate", () => {
    h.account = null;
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getAllByTestId("position-row")).toHaveLength(1);
    expect(screen.getByTestId("position-nft-badge")).toBeInTheDocument();
  });
  it("CONTROL normal-only: exactly one row, no badge", () => {
    h.wrapped = null;
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getAllByTestId("position-row")).toHaveLength(1);
    expect(screen.queryByTestId("position-nft-badge")).toBeNull();
  });
});

describe("the wrapped-extra section's chrome (audit #40 consensus details)", () => {
  it("labels the wrapped row as its own section, once", () => {
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getAllByText("// wrapped as nft")).toHaveLength(1);
  });
  it("shows no wrapped section label in either single-position case", () => {
    h.wrapped = null;
    const { unmount } = render(<PositionsDock slabAddress="s" />);
    expect(screen.queryByText("// wrapped as nft")).toBeNull();
    unmount();
    h.account = null;
    h.wrapped = { ...acct({ positionSize: -20_000_000n, capital: 500_000_000n }), nftMint: OWNER, nftPda: OWNER };
    render(<PositionsDock slabAddress="s" />);
    expect(screen.queryByText("// wrapped as nft")).toBeNull();
  });
});

describe("market-level chrome stays on the primary instance (audit #40)", () => {
  it("renders the warmup bar and the engine-stale banner once, not per instance", () => {
    h.engineStale = true;
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getAllByTestId("position-row")).toHaveLength(2);
    expect(screen.getAllByTestId("warmup-progress")).toHaveLength(1);
    expect(screen.getAllByText("Catching up with the latest prices")).toHaveLength(1);
    h.engineStale = false;
  });
});
