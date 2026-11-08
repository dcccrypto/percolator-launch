/** M7 (L-4): the spread quote is read at mount and read AGAIN when the confirm opens (refreshKey), not on every render. */
import { renderHook, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getMultipleAccountsInfo: vi.fn(),
  resolveLp: vi.fn(),
}));
const MARKET = "11111111111111111111111111111111";
const PROG = new PublicKey("5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe");
const CTX = new PublicKey("5dsrhZiXunvXcFbCzdJ9Qg5Lv3eX4SGyaBA6NZ3SaoKh");
const connection = { getMultipleAccountsInfo: mocks.getMultipleAccountsInfo };

vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: () => ({ connection }) }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ slabAddress: MARKET, programId: PROG }) }));
vi.mock("@/hooks/useTrade", () => ({ resolveLpTradeAccounts: mocks.resolveLp }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false }));
vi.mock("@/lib/limits/decode", () => ({
  decodeMarketEngineView: () => ({ effectivePriceE6: 100_000_000n }),
  decodeAssetRiskLimits: () => ({ matcherExtMode: 1, maxRequestedFeeBps: 100 }),
  decodeMatcherCtx: () => ({ kind: 1, baseSpreadBps: 20, maxTotalBps: 80, v2: null }),
}));

import { useSpreadQuoter } from "@/hooks/useSpreadQuoter";

describe("useSpreadQuoter refresh (L-4)", () => {
  it("reads once at mount, does NOT re-read on a re-render, and reads again when refreshKey changes (the confirm opens)", async () => {
    mocks.resolveLp.mockResolvedValue({ matcherCtx: CTX });
    mocks.getMultipleAccountsInfo.mockResolvedValue([{ data: new Uint8Array(8) }, { data: new Uint8Array(8) }]);
    const { result, rerender } = renderHook(({ k }) => useSpreadQuoter(true, 0, k), { initialProps: { k: 0 } });
    await waitFor(() => expect(mocks.getMultipleAccountsInfo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current(1_000_000n, true)).toMatchObject({ kind: "range", inFee: true }));
    rerender({ k: 0 });
    rerender({ k: 0 });
    expect(mocks.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    rerender({ k: 1 });
    await waitFor(() => expect(mocks.getMultipleAccountsInfo).toHaveBeenCalledTimes(2));
  });
});
