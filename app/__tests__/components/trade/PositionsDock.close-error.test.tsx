/**
 * Dock Close modal: a failed close must show the hook's (already humanized)
 * error INSIDE the modal. The dock's own below-table copy sits under the
 * modal's full-screen overlay. Reopening after Cancel must not show the
 * previous attempt's error.
 */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ account: null as unknown }));
const OWNER = new PublicKey("11111111111111111111111111111111");

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.account }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));
// Stateful stand-in for useClosePosition: a failed close sets the mapped
// error and throws (the real hook's catch contract); resetPhase clears it.
vi.mock("@/hooks/useClosePosition", async () => {
  const React = await import("react");
  return {
    useClosePosition: () => {
      const [error, setError] = React.useState<string | null>(null);
      return {
        closePosition: async () => { setError("Transaction cancelled."); throw new Error("rejected"); },
        loading: false,
        error,
        phase: "idle",
        lastSig: null,
        resetPhase: () => setError(null),
        prewarmClose: () => {},
      };
    },
  };
});
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    accounts: [],
    config: { collateralMint: OWNER, lastEffectivePriceE6: 100_000_000n, invert: 0 },
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    adlFactors: null,
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
  localStorage.clear();
  h.account = {
    idx: 0, pubkey: OWNER,
    account: { kind: 0, owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 40_000_000n, entryPrice: 0n, adlABasis: 0n, reservedPnl: 0n, feeCredits: 0n },
  };
});

const failClose = async () => {
  fireEvent.click(screen.getByTestId("position-close"));
  await act(async () => { fireEvent.click(screen.getByTestId("close-confirm")); });
};

describe("PositionsDock close modal error", () => {
  it("shows a failed close's error inside the still-open modal", async () => {
    render(<PositionsDock slabAddress="s" />);
    await failClose();
    const modal = screen.getByTestId("close-modal");
    expect(within(modal).getByTestId("close-error")).toHaveTextContent("Transaction cancelled.");
  });

  it("does not carry the previous attempt's error into a reopened modal", async () => {
    render(<PositionsDock slabAddress="s" />);
    await failClose();
    expect(within(screen.getByTestId("close-modal")).getByTestId("close-error")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("close-cancel"));
    expect(screen.queryByTestId("close-modal")).toBeNull();
    fireEvent.click(screen.getByTestId("position-close"));
    expect(within(screen.getByTestId("close-modal")).queryByTestId("close-error")).toBeNull();
  });
});
