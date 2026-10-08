/**
 * Every Close entry point uses the chain-aware gate, and the form honours it.
 *  - PositionsDock is rendered end to end (Confirm enabled / disabled).
 *  - The other entry points are bound by source: each computes `oracleCloseGate`
 *    and hands `oraclePriceBehind` down to the shared ClosePositionForm.
 */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  account: null as unknown,
  fresh: {} as Record<string, unknown>,
  engineStale: false,
}));
const OWNER = new PublicKey("11111111111111111111111111111111");
const PUSH_MANAGED = { chainRuleKnown: true, resolveMatured: false, feedMaxStalenessSecs: null };

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.account, useUserAccountScanPending: () => false }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));
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
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => h.fresh }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: h.engineStale }) }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => null }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccount: () => null }));
vi.mock("@/components/dev/RenderProfiler", () => ({ RenderProfiler: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/trade/OtherMarketPositions", () => ({ OtherMarketPositions: () => null }));
vi.mock("@/components/trade/TradeHistory", () => ({ TradeHistory: () => null }));
vi.mock("@/components/trade/WarmupProgress", () => ({ WarmupProgress: () => null }));
vi.mock("@/components/trade/PositionNftMenu", () => ({ PositionNftMenu: () => null, ClosedPositionNftNotice: () => null, NFT_MENU_COPY: { badge: "NFT", closeWrapped: "Unwrap to close this position" } }));

import { PositionsDock } from "@/components/trade/PositionsDock";

const openClose = () => {
  render(<PositionsDock slabAddress="s" />);
  fireEvent.click(screen.getByTestId("position-close"));
  return screen.getByTestId("close-confirm");
};

beforeEach(() => {
  localStorage.clear();
  h.engineStale = false;
  h.fresh = { level: "stale", mode: "keeper", ready: true, elapsedSecs: 300, closeFacts: PUSH_MANAGED };
  h.account = {
    idx: 0, pubkey: OWNER,
    account: { kind: 0, owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 40_000_000n, entryPrice: 0n, adlABasis: 1_000_000_000_000_000n, reservedPnl: 0n, feeCredits: 0n },
  };
});

describe("Close Confirm (dock)", () => {
  it("stale 5 minutes on an AUTH_MARK market: Confirm enabled, one calm note", () => {
    const confirm = openClose();
    expect(confirm).toBeEnabled();
    expect(screen.getByTestId("close-price-behind")).toHaveTextContent("The price shown may be a little behind.");
    expect(screen.queryByText(/Oracle Stale/)).toBeNull();
  });
  it("matured: Confirm blocked", () => {
    h.fresh = { ...h.fresh, closeFacts: { ...PUSH_MANAGED, resolveMatured: true } };
    expect(openClose()).toBeDisabled();
    expect(screen.queryByTestId("close-price-behind")).toBeNull();
  });
  it("engine catching up: Confirm blocked", () => {
    h.engineStale = true;
    render(<PositionsDock slabAddress="s" />);
    // the dock disables its own Close button while the engine is catching up (unchanged)
    expect(screen.getByTestId("position-close")).toBeDisabled();
  });
  it("price unavailable: Confirm blocked", () => {
    h.fresh = { level: "unavailable", mode: "keeper", ready: false, elapsedSecs: 0, closeFacts: PUSH_MANAGED };
    expect(openClose()).toBeDisabled();
  });
  it("fresh: Confirm enabled, no note", () => {
    h.fresh = { level: "fresh", mode: "keeper", ready: true, elapsedSecs: 2, closeFacts: PUSH_MANAGED };
    expect(openClose()).toBeEnabled();
    expect(screen.queryByTestId("close-price-behind")).toBeNull();
  });
});

describe("every Close entry point uses the chain-aware gate", () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, "../../..", rel), "utf8");
  // dock row, trade-page panel, other-markets rows (also the at-risk strip and the
  // site-wide alert via RiskCloseFlow -> CloseFlow), /portfolio rows
  it.each([
    "components/trade/PositionsDock.tsx",
    "components/trade/PositionPanel.tsx",
    "components/trade/OtherMarketPositions.tsx",
    "components/portfolio/PortfolioPositionsView.tsx",
  ])("%s gates the close on oracleCloseGate and forwards the note", (rel) => {
    const src = read(rel);
    expect(src).toContain("oracleCloseGate(");
    expect(src).toContain("oraclePriceBehind={oraclePriceBehind}");
    expect(src).not.toContain("isOracleStaleBlocking");
  });
  it("order ticket: Close tab uses the close gate, opening keeps the 60 s rule", () => {
    const src = read("components/trade/OrderTicket.tsx");
    expect(src).toContain("oracleCloseGate(");
    expect(src).toContain("oracleBlocked={!mockMode && closeGate.blocked}");
    expect(src).toContain("oraclePriceBehind={!mockMode && closeGate.behind}");
    expect(src).toMatch(/const oracleStale = !oracleUnavailable && isOracleStaleBlocking\(/);
    expect(src).toContain("waitingForPrice: !mockMode && (oracleUnavailable || oracleStale");
  });
  it("close panel and modal forward the note to the shared form", () => {
    expect(read("components/trade/OrderTicketClosePanel.tsx")).toContain("oraclePriceBehind={oraclePriceBehind}");
    expect(read("components/trade/ClosePositionModal.tsx")).toContain("oraclePriceBehind={oraclePriceBehind}");
  });
});

describe("ClosePositionForm (shared by every entry point)", () => {
  it("engine catching up blocks Confirm and shows its own note, not the price note", async () => {
    const { ClosePositionForm } = await import("@/components/trade/ClosePositionForm");
    render(
      <ClosePositionForm
        positionSize={40_000_000n} entryPrice={0n} currentPrice={100_000_000n} capital={1_000_000_000n}
        symbol="SOL" decimals={6} priceUsd={100} isLong loading={false} oraclePriceBehind engineCatchingUp
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByTestId("close-confirm")).toBeDisabled();
    expect(screen.getByTestId("close-catching-up")).toBeInTheDocument();
    expect(screen.queryByTestId("close-price-behind")).toBeNull();
  });
});
