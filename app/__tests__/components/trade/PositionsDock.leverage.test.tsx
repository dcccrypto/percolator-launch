/**
 * PositionsDock row: shows the CURRENT effective leverage
 * (notional / (capital + pnl)) with the cross-margin tooltip — and "—" when
 * equity <= 0 or the mark is unknown.
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
    entryPrice: 0n, adlABasis: 0n, reservedPnl: 0n, feeCredits: 0n,
    ...over,
  },
});

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.account }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), loading: false, error: null, prewarmClose: vi.fn() }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    accounts: [],
    config: { collateralMint: OWNER, lastEffectivePriceE6: 100_000_000n, invert: 0 },
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    adlFactors: null,
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

beforeEach(() => {
  localStorage.clear();
  h.priceE6 = 100_000_000n;
  h.account = acct({});
});

const lev = () => screen.getByTestId("position-leverage");

describe("PositionsDock leverage column", () => {
  it("renders the column with the cross-margin tooltip", () => {
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getByText("Lev")).toBeInTheDocument();
    expect(lev().textContent).toBe("4×"); // 40 x $100 = $4000 on $1000
    expect(lev().getAttribute("title")).toMatch(/cross/i);
    expect(lev().getAttribute("title")).toMatch(/not the leverage you opened at/i);
  });

  it("uses equity (capital + pnl)", () => {
    h.account = acct({ pnl: -500_000_000n });
    render(<PositionsDock slabAddress="s" />);
    expect(lev().textContent).toBe("8×");
  });

  it("follows the mark price", () => {
    h.priceE6 = 50_000_000n;
    render(<PositionsDock slabAddress="s" />);
    expect(lev().textContent).toBe("2×");
  });

  it("shows a dash when equity <= 0", () => {
    h.account = acct({ pnl: -1_000_000_000n });
    render(<PositionsDock slabAddress="s" />);
    expect(lev().textContent).toBe("—");
    expect(lev().getAttribute("title")).toMatch(/zero or negative/i);
  });
});

/** UX WP-9 AC6 (audit §3.13): the NFT actions sit in the position row's "⋯" menu. */
describe("PositionsDock: NFT actions in the row", () => {
  it("the position row carries the NFT menu next to Close", () => {
    render(<PositionsDock slabAddress="s" />);
    const row = screen.getByTestId("position-row");
    expect(row.querySelector('[data-testid="nft-menu-marker"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="position-close"]')).not.toBeNull();
  });
});

// H8: the empty state also hosts the Unwrap for a position that closed while wrapped (no row exists for it).
describe("PositionsDock: closed NFT position", () => {
  it("mounts the closed-NFT notice under the empty state with no account", () => {
    h.account = null;
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getByText("No open positions")).toBeInTheDocument();
    expect(screen.getByTestId("closed-nft-marker")).toBeInTheDocument();
  });

  it("mounts it with a flat account too", () => {
    h.account = acct({ positionSize: 0n });
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getByText("Use the order ticket to open a position.")).toBeInTheDocument();
    expect(screen.getByTestId("closed-nft-marker")).toBeInTheDocument();
  });

  it("not when a position row renders", () => {
    render(<PositionsDock slabAddress="s" />);
    expect(screen.queryByTestId("closed-nft-marker")).toBeNull();
    expect(lev()).toBeInTheDocument();
  });
});
