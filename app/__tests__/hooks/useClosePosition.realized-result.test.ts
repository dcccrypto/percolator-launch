import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { modeFixtures } from "../helpers/v22-fixtures";
import { fillEventLogs } from "../helpers/fill-event-fixture";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// M-3: a v17/v18 close reads the market fresh for the ADL-effective quantity (real v18 bytes).
// Captured market of the ACTIVE mode: the v2.1 ANSEM bytes flag off, the v2.2 (VERSION 19) one-slot market flag on (helpers/v22-fixtures.ts).
const MARKET_BYTES = Buffer.from(modeFixtures().market);

const mocks = vi.hoisted(() => ({
  trade: vi.fn(),
  fetchSlab: vi.fn(),
  parseAccount: vi.fn(),
  isV17Account: vi.fn(),
  parsePortfolioV17: vi.fn(),
  getProgramAccounts: vi.fn(),
  getLivePriceSnapshot: vi.fn(),
  invalidatePortfolio: vi.fn(),
  withdraw: vi.fn(),
  toast: vi.fn(),
  takeFillResult: vi.fn(),
  getTransaction: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));

vi.mock("@/hooks/useTrade", () => ({
  useTrade: vi.fn(),
  // Fire-and-forget prewarm called at the top of the v17 verification path —
  // a plain no-op here (the real one only warms caches).
  prewarmTradeSubmission: vi.fn(),
}));

vi.mock("@/hooks/useWithdraw", () => ({ useWithdraw: () => ({ withdraw: mocks.withdraw }) }));
vi.mock("@/hooks/useToast", () => ({ useOptionalToast: () => mocks.toast }));
vi.mock("@/lib/limits/fill-check", () => ({ takeFillResult: (sig: string) => mocks.takeFillResult(sig) }));

vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: vi.fn(),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(),
}));

vi.mock("@/lib/priceStore/priceStore", () => ({
  getLivePriceSnapshot: mocks.getLivePriceSnapshot,
}));

vi.mock("@/lib/v22/flag", async (orig) => ({ ...(await orig<object>()), isDevnetV22Enabled: () => true }));
vi.mock("@/lib/mock-mode", () => ({
  isMockMode: () => false,
}));

vi.mock("@/lib/mock-trade-data", () => ({
  isMockSlab: () => false,
}));

vi.mock("@/lib/lpPortfolio", () => ({ isLpPortfolio: () => false }));

vi.mock("@/lib/portfolio-invalidation", () => ({
  invalidatePortfolio: mocks.invalidatePortfolio,
}));

vi.mock("@/lib/errorMessages", async (orig) => ({
  ...(await orig<typeof import("@/lib/errorMessages")>()),
  humanizeError: (message: string) => message,
  withTransientRetry: async (
    operation: () => Promise<unknown>,
  ) => operation(),
}));

vi.mock("@/lib/v22/layout", async (orig) => ({
  ...(await orig<typeof import("@/lib/v22/layout")>()),
  isWrapperAccount: mocks.isV17Account,
  parsePortfolio: mocks.parsePortfolioV17,
}));
vi.mock("@percolatorct/sdk", () => ({
  AccountKind: {
    LP: "LP",
  },
  isV17Account: mocks.isV17Account,
  parsePortfolioV17: mocks.parsePortfolioV17,
  fetchSlab: mocks.fetchSlab,
  parseAccount: mocks.parseAccount,
}));

import {
  useConnectionCompat,
  useWalletCompat,
} from "@/hooks/useWalletCompat";
import { useTrade } from "@/hooks/useTrade";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useClosePosition } from "@/hooks/useClosePosition";
import { __setUnknownLotExpForTest } from "@/lib/v22/lot-registry";
import { getRealized } from "@/lib/realized-pnl";

/**
 * M7: the close toast reports what the chain did: the price the close was BOOKED at (FILL event) and the realized result from the
 * account's value before/after (capital + settled pnl), fees and spread included. Council round trip: 44.14 in, 43.728 out = -0.412.
 */
describe("useClosePosition: executed price and reconciled realized result (M7)", () => {
  const slabAddress = "11111111111111111111111111111111";
  const walletPublicKey = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const programId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  let closed = false;
  const openLeg = { active: true, side: 0, aBasis: 1_000_000_000_000_000n, epochSnap: 0n, basisPosQ: 2n };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    __setUnknownLotExpForTest(0);
    mocks.takeFillResult.mockReturnValue(undefined);
    closed = false;
    mocks.trade.mockImplementation(async () => { closed = true; return "close-sig"; });
    mocks.withdraw.mockResolvedValue("withdraw-sig");
    mocks.isV17Account.mockReturnValue(true);
    mocks.getLivePriceSnapshot.mockReturnValue({ priceE6: 89_500_000n });
    mocks.getProgramAccounts.mockResolvedValue([{ pubkey: walletPublicKey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockImplementation(() =>
      closed
        ? { owner: walletPublicKey, capital: 43_728_000n, pnl: 0n, legs: [{ ...openLeg, active: false }] }
        : { owner: walletPublicKey, capital: 44_140_000n, pnl: 0n, legs: [openLeg] },
    );
    mocks.getTransaction.mockResolvedValue({
      meta: { err: null, logMessages: fillEventLogs(programId, new PublicKey(slabAddress), [{ flags: 8, requestedQ: -2n, executedQ: -2n, priceE6: 89_311_989n, quotedPriceE6: 89_500_000n }]) },
    });
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: { getProgramAccounts: mocks.getProgramAccounts, getAccountInfo: async () => ({ data: MARKET_BYTES }), getTransaction: mocks.getTransaction },
    } as unknown as ReturnType<typeof useConnectionCompat>);
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: walletPublicKey, connected: true } as ReturnType<typeof useWalletCompat>);
    vi.mocked(useTrade).mockReturnValue({ trade: mocks.trade } as unknown as ReturnType<typeof useTrade>);
    vi.mocked(useUserAccount).mockReturnValue({ idx: 7, account: { positionSize: 2n } } as ReturnType<typeof useUserAccount>);
    vi.mocked(useSlabState).mockReturnValue({
      accounts: [{ idx: 3, account: { kind: "LP" } }], raw: Buffer.from([1]), programId,
    } as unknown as ReturnType<typeof useSlabState>);
  });

  it("the toast names the booked price (not the 89.50 mark) and the -0.412 net result, and the ledger records it", async () => {
    const { result } = renderHook(() => useClosePosition(slabAddress));
    await act(async () => { await result.current.closePosition(100, { skipSweep: true }); });
    expect(mocks.toast).toHaveBeenCalledWith(
      "Position closed. Executed at $89.311989. Realized −0.412 USDC (fees and spread included).",
      "success",
    );
    expect(getRealized(walletPublicKey.toBase58(), slabAddress)).toBe(-412_000n);
  });

  it("NEGATIVE: the price could not be read: the realized half still reports, and no price is claimed", async () => {
    mocks.getTransaction.mockResolvedValue(null);
    const { result } = renderHook(() => useClosePosition(slabAddress));
    await act(async () => { await result.current.closePosition(100, { skipSweep: true }); });
    expect(mocks.toast).toHaveBeenCalledWith("Position closed. Realized −0.412 USDC (fees and spread included).", "success");
  });

  it("a profit lands in pnl and reads as a gain", async () => {
    mocks.parsePortfolioV17.mockImplementation(() =>
      closed
        ? { owner: walletPublicKey, capital: 44_140_000n, pnl: 700_000n, legs: [{ ...openLeg, active: false }] }
        : { owner: walletPublicKey, capital: 44_140_000n, pnl: 0n, legs: [openLeg] },
    );
    const { result } = renderHook(() => useClosePosition(slabAddress));
    await act(async () => { await result.current.closePosition(100, { skipSweep: true }); });
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("Realized +0.7 USDC"), "success");
  });
});
