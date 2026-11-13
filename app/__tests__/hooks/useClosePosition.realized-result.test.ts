import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { modeFixtures } from "../helpers/v22-fixtures";
import closeFx from "../fixtures/v22-sol-close-3fcYeu1m.json";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { effectivePriceE6, execFillFromLogs } from "@/lib/v22/exec-fill";
import { formatLotPriceE6 } from "@/lib/v22/lot";
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
  readFundingSample: vi.fn(),
}));

vi.mock("@/lib/funding-flow", async (orig) => ({ ...(await orig<typeof import("@/lib/funding-flow")>()), readFundingSample: mocks.readFundingSample }));

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
import { getLastResult, getRealized } from "@/lib/realized-pnl";
import { loadBook, saveBook } from "@/lib/trade-book";

/**
 * M7: the close toast reports what the chain did, from the close's own FILL event: the price effectively received (booked price adjusted
 * by the spread part of fee_atoms) and, when the whole trade was seen, its lifetime result (price PnL on booked prices minus every fee).
 * Real council transactions: open 27o3fM4W (booked in the stored book) and close 3fcYeu1m (replayed through the real hook).
 */
const SOL_WRAPPER = new PublicKey("5NGgnU2j315Ci2tso8VJDEthaVExuiKG3tn4xnur28xe");
const SOL_MARKET = "G2wipz3k28TyVqdKnzpTcEGWkB4bHJXwNrCbi4DVgPez";
const SOL_PORTFOLIO = new PublicKey("5dsrhZiXunvXcFbCzdJ9Qg5Lv3eX4SGyaBA6NZ3SaoKh");
const wallet = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const Q = 223_463n;
// from the real open: booked 89,535,739, fee 106,043; the real close: booked 89,607,382, fee 102,123
const FUNDING_BASE = 1_000_000n;
const FUNDING_PAID = 1_234n; // the chain moved 1,234 atoms of funding over the hold
const PRICE_AND_FEES = (Q * (89_607_382n - 89_535_739n)) / 1_000_000n - 106_043n - 102_123n;
const EXPECT_RESULT = PRICE_AND_FEES - FUNDING_PAID;

describe("useClosePosition: effective price and lifetime trade result (M7)", () => {
  const openLeg = { active: true, side: 0, aBasis: 1_000_000_000_000_000n, epochSnap: 0n, basisPosQ: Q };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    __setUnknownLotExpForTest(0);
    mocks.takeFillResult.mockReturnValue(undefined);
    // r10: the funding counters after the closing fill: flat, 1,234 atoms paid over the trade (the book's base is 1,000,000).
    mocks.readFundingSample.mockResolvedValue({ netPaid: FUNDING_BASE + FUNDING_PAID, legs: 0 });
    mocks.trade.mockResolvedValue("close-sig");
    mocks.withdraw.mockResolvedValue("withdraw-sig");
    mocks.isV17Account.mockReturnValue(true);
    mocks.getLivePriceSnapshot.mockReturnValue({ priceE6: 89_500_000n });
    mocks.getProgramAccounts.mockResolvedValue([{ pubkey: SOL_PORTFOLIO, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockImplementation(() => ({ owner: wallet, capital: 44_140_000n, pnl: 0n, legs: [openLeg] }));
    mocks.getTransaction.mockResolvedValue({ slot: 123, meta: { err: null, logMessages: closeFx.logMessages } });
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: { getProgramAccounts: mocks.getProgramAccounts, getAccountInfo: async () => ({ data: MARKET_BYTES }), getTransaction: mocks.getTransaction },
    } as unknown as ReturnType<typeof useConnectionCompat>);
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: wallet, connected: true } as ReturnType<typeof useWalletCompat>);
    vi.mocked(useTrade).mockReturnValue({ trade: mocks.trade } as unknown as ReturnType<typeof useTrade>);
    vi.mocked(useUserAccount).mockReturnValue({ idx: 7, pubkey: SOL_PORTFOLIO, account: { positionSize: Q } } as unknown as ReturnType<typeof useUserAccount>);
    vi.mocked(useSlabState).mockReturnValue({
      accounts: [{ idx: 3, account: { kind: "LP" } }], raw: Buffer.from([1]), programId: SOL_WRAPPER,
    } as unknown as ReturnType<typeof useSlabState>);
  });

  const seedOpen = () => saveBook(wallet.toBase58(), SOL_MARKET, SOL_PORTFOLIO.toBase58(), { q: Q, avgE6: 89_535_739n, fees: 106_043n, pnl: 0n, fundingBase: FUNDING_BASE });
  const effective = () => {
    const f = execFillFromLogs(closeFx.logMessages, SOL_WRAPPER, { market: new PublicKey(SOL_MARKET) })!;
    return formatLotPriceE6(effectivePriceE6(f, decodeMarketEngineView(new Uint8Array(MARKET_BYTES))!.tradeFeeBaseBps), 0);
  };

  it("the toast names the EFFECTIVE price (not the 89.607 mark) and the lifetime result including the open's fee; the ledger records it", async () => {
    seedOpen();
    const { result } = renderHook(() => useClosePosition(SOL_MARKET));
    await act(async () => { await result.current.closePosition(100, { skipSweep: true }); });
    const call = mocks.toast.mock.calls.map((c) => c[0] as string).find((t) => t.startsWith("Position closed."))!;
    expect(call).toContain(`Effective price ${effective()}.`);
    expect(call).not.toContain("$89.607382");
    expect(call).toContain("Trade result −0.193391 USDC (trading fees, spread, other fees and funding included). Counted from trades made on this device; a trade on another device can make this figure wrong.");
    expect(PRICE_AND_FEES).toBe(-192_157n);
    expect(EXPECT_RESULT).toBe(-193_391n); // the old figure minus the funding paid
    expect(getRealized(wallet.toBase58(), SOL_MARKET)).toBe(EXPECT_RESULT);
    expect(getLastResult(wallet.toBase58(), SOL_MARKET)).toBe(EXPECT_RESULT);
    expect(loadBook(wallet.toBase58(), SOL_MARKET, SOL_PORTFOLIO.toBase58())).toBeNull();
  });

  it("r10: the funding counters could not be read at the close: NO money result is claimed (never one that leaves funding out)", async () => {
    seedOpen();
    mocks.readFundingSample.mockResolvedValue(null);
    const { result } = renderHook(() => useClosePosition(SOL_MARKET));
    await act(async () => { await result.current.closePosition(100, { skipSweep: true }); });
    const call = mocks.toast.mock.calls.map((c) => c[0] as string).find((t) => t.startsWith("Position closed."))!;
    expect(call).toContain("Effective price");
    expect(call).not.toMatch(/Trade result/);
    expect(getRealized(wallet.toBase58(), SOL_MARKET)).toBeNull();
  });

  it("r10: a book saved before funding was tracked (no base) claims no result either", async () => {
    saveBook(wallet.toBase58(), SOL_MARKET, SOL_PORTFOLIO.toBase58(), { q: Q, avgE6: 89_535_739n, fees: 106_043n, pnl: 0n, fundingBase: null });
    const { result } = renderHook(() => useClosePosition(SOL_MARKET));
    await act(async () => { await result.current.closePosition(100, { skipSweep: true }); });
    const call = mocks.toast.mock.calls.map((c) => c[0] as string).find((t) => t.startsWith("Position closed."))!;
    expect(call).not.toMatch(/Trade result/);
  });

  it("NEGATIVE: the trade was opened where the app did not see it (no book): the effective price shows, NO money result is claimed", async () => {
    const { result } = renderHook(() => useClosePosition(SOL_MARKET));
    await act(async () => { await result.current.closePosition(100, { skipSweep: true }); });
    const call = mocks.toast.mock.calls.map((c) => c[0] as string).find((t) => t.startsWith("Position closed."))!;
    expect(call).toContain("Effective price");
    expect(call).not.toMatch(/Trade result|Realized|profit/);
    expect(getRealized(wallet.toBase58(), SOL_MARKET)).toBeNull();
  });

  it("L-2: a FILL of another portfolio in the same tx is not this user's: nothing is claimed", async () => {
    seedOpen();
    vi.mocked(useUserAccount).mockReturnValue({ idx: 7, pubkey: wallet, account: { positionSize: Q } } as unknown as ReturnType<typeof useUserAccount>);
    const { result } = renderHook(() => useClosePosition(SOL_MARKET));
    await act(async () => { await result.current.closePosition(100, { skipSweep: true }); });
    expect(mocks.toast.mock.calls.map((c) => c[0] as string)).toContain("Position closed.");
  });

  it("NEGATIVE: the fill could not be read: plain toast, no price, no result", async () => {
    seedOpen();
    mocks.getTransaction.mockResolvedValue(null);
    const { result } = renderHook(() => useClosePosition(SOL_MARKET));
    await act(async () => { await result.current.closePosition(100, { skipSweep: true }); });
    expect(mocks.toast.mock.calls.map((c) => c[0] as string)).toContain("Position closed.");
  });
});
