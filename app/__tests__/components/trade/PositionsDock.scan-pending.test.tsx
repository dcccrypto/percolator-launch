/**
 * GH#2707: the dock must not assert "no account" while the portfolio scan is in flight.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  account: null as unknown,
  pending: false,
  connected: false,
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

vi.mock("@/hooks/useWalletCompat", async (orig) => ({
  ...(await orig<object>()),
  useWalletCompat: () => ({ connected: h.connected, publicKey: null }),
}));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.account, useUserAccountScanPending: () => h.pending }));
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
vi.mock("@/components/trade/PositionNftMenu", () => ({ PositionNftMenu: () => <span data-testid="nft-menu-marker" />, ClosedPositionNftNotice: () => null, NFT_MENU_COPY: { badge: "NFT", closeWrapped: "Unwrap to close this position" } }));

import { PositionsDock } from "@/components/trade/PositionsDock";

beforeEach(() => {
  localStorage.clear();
  h.priceE6 = 100_000_000n;
  h.account = null;
  h.pending = false;
  h.connected = false;
});

describe("PositionsDock while the portfolio scan is pending (GH#2707)", () => {
  it("shows loading, not the no-account empty state, while the scan has not answered", () => {
    h.pending = true;
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getByText("Loading positions…")).toBeInTheDocument();
    expect(screen.queryByText(/Connect your wallet and deposit collateral/)).toBeNull();
    expect(screen.queryByText("No open positions")).toBeNull();
  });

  it("CONTROL: once the scan answers 'no account', the no-account empty state renders as before", () => {
    h.pending = false;
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getByText("No open positions")).toBeInTheDocument();
    expect(screen.getByText(/Connect your wallet and deposit collateral/)).toBeInTheDocument();
  });

  // #61: a connected wallet with no account here was told to "Connect your wallet".
  it("a connected wallet with no account on this market is pointed at the ticket, not told to connect", () => {
    h.connected = true;
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getByText("No open positions")).toBeInTheDocument();
    expect(screen.queryByText(/Connect your wallet/)).toBeNull();
    expect(screen.getByText(/Your first trade sets up your account here/)).toBeInTheDocument();
  });

  it("a known position renders normally even if the pending flag were still set", () => {
    h.pending = true;
    h.account = acct({});
    render(<PositionsDock slabAddress="s" />);
    expect(screen.getByTestId("position-leverage").textContent).toBe("4×");
    expect(screen.queryByText("Loading positions…")).toBeNull();
  });
});
