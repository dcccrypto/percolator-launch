/**
 * The saved entry (lib/entry-price.ts) is the only source of Entry / PnL / ROE on v17/v18. Every close
 * surface cleared it on a 100% REQUEST, so when LP headroom clipped the close to a partial fill, the
 * rest of the position lost its entry. useClosePosition now clears it only when the position is
 * actually flat (outcome "closed"). Harness from useClosePosition.sweep-to-wallet.test.ts.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MARKET_BYTES = Buffer.from(
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "5bVTTMRc.ansem.market.json"), "utf8")).dataBase64,
  "base64",
);

const mocks = vi.hoisted(() => ({
  trade: vi.fn(),
  isV17Account: vi.fn(),
  parsePortfolioV17: vi.fn(),
  getProgramAccounts: vi.fn(),
  getLivePriceSnapshot: vi.fn(),
  fill: { current: null as unknown },
  toast: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: vi.fn(), useWalletCompat: vi.fn() }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: vi.fn(), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useWithdraw", () => ({ useWithdraw: () => ({ withdraw: vi.fn().mockResolvedValue("w") }) }));
vi.mock("@/hooks/useToast", () => ({ useOptionalToast: () => mocks.toast }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: vi.fn() }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: vi.fn() }));
vi.mock("@/lib/priceStore/priceStore", () => ({ getLivePriceSnapshot: mocks.getLivePriceSnapshot }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false }));
vi.mock("@/lib/lpPortfolio", () => ({ isLpPortfolio: () => false }));
vi.mock("@/lib/portfolio-invalidation", () => ({ invalidatePortfolio: vi.fn() }));
vi.mock("@/lib/errorMessages", () => ({
  humanizeError: (message: string) => message,
  withTransientRetry: async (operation: () => Promise<unknown>) => operation(),
}));
vi.mock("@/lib/limits/fill-check", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/fill-check")>()),
  takeFillResult: () => mocks.fill.current,
}));
vi.mock("@percolatorct/sdk", () => ({
  AccountKind: { LP: "LP" },
  isV17Account: mocks.isV17Account,
  parsePortfolioV17: mocks.parsePortfolioV17,
  fetchSlab: vi.fn(),
  parseAccount: vi.fn(),
}));

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useTrade } from "@/hooks/useTrade";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useClosePosition } from "@/hooks/useClosePosition";
import { getEntryPrice, saveEntryPrice } from "@/lib/entry-price";

describe("useClosePosition keeps the saved entry unless the position is flat", () => {
  const slab = "11111111111111111111111111111111";
  const wallet = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const programId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  const openLeg = { active: true, side: 0, aBasis: 1_000_000_000_000_000n, epochSnap: 0n, basisPosQ: 2n };
  const entry = () => getEntryPrice(slab, 7, wallet.toBase58());

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    saveEntryPrice(slab, 7, 95_000_000n, 2, wallet.toBase58());
    mocks.fill.current = null;
    mocks.trade.mockResolvedValue("close-sig");
    mocks.isV17Account.mockReturnValue(true);
    mocks.getLivePriceSnapshot.mockReturnValue({ priceE6: 100_000_000n });
    mocks.getProgramAccounts.mockResolvedValue([{ pubkey: wallet, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockReturnValue({ owner: wallet, capital: 500_000_000n, legs: [openLeg] });
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: { getProgramAccounts: mocks.getProgramAccounts, getAccountInfo: async () => ({ data: MARKET_BYTES }) },
    } as ReturnType<typeof useConnectionCompat>);
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: wallet, connected: true } as ReturnType<typeof useWalletCompat>);
    vi.mocked(useTrade).mockReturnValue({ trade: mocks.trade } as unknown as ReturnType<typeof useTrade>);
    vi.mocked(useUserAccount).mockReturnValue({ idx: 7, account: { positionSize: 2n } } as ReturnType<typeof useUserAccount>);
    vi.mocked(useSlabState).mockReturnValue({
      accounts: [{ idx: 3, account: { kind: "LP" } }], raw: Buffer.from([1]), programId,
    } as unknown as ReturnType<typeof useSlabState>);
  });

  it("Close 100% that fills in full: the entry is cleared", async () => {
    mocks.fill.current = { kind: "full", filledQ: -2n };
    const { result } = renderHook(() => useClosePosition(slab));
    await act(async () => { await result.current.closePosition(100); });
    expect(entry()).toBe(0n);
  });

  it("Close 100% that only partly fills: the rest of the position keeps its entry", async () => {
    mocks.fill.current = { kind: "partial", filledQ: -1n };
    const { result } = renderHook(() => useClosePosition(slab));
    await act(async () => { await result.current.closePosition(100); });
    expect(result.current.error).toMatch(/Partially closed/i);
    // /portfolio, other-markets, the liquidation alert and the at-risk banner unmount that error on resolve.
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/^Partially closed: .+ The rest of your position is still open.$/), "info");
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.anything(), "success");
    expect(entry()).toBe(95_000_000n);
  });

  it("CONTROL: Close 50% keeps the entry", async () => {
    const { result } = renderHook(() => useClosePosition(slab));
    await act(async () => { await result.current.closePosition(50); });
    expect(entry()).toBe(95_000_000n);
  });

  it("no close surface clears the entry itself on a 100% request", () => {
    const src = (rel: string) => readFileSync(join(__dirname, "..", "..", rel), "utf8");
    for (const f of [
      "components/trade/PositionsDock.tsx",
      "components/trade/PositionPanel.tsx",
      "components/portfolio/PortfolioPositionsView.tsx",
      "components/trade/OtherMarketPositions.tsx",
    ]) {
      expect(src(f), f).not.toMatch(/clearEntryPrice\(/);
    }
    // OrderTicket clears only on the OPEN path (scaling into an existing position), never in handleClosed.
    const ticket = src("components/trade/OrderTicket.tsx");
    const closed = ticket.slice(ticket.indexOf("const handleClosed"), ticket.indexOf("const handleClosed") + 400);
    expect(closed).not.toMatch(/clearEntryPrice\(/);
  });

  it("CONTROL: no measured fill (legacy path) still clears on a 100% close, as before", async () => {
    mocks.fill.current = null;
    const { result } = renderHook(() => useClosePosition(slab));
    await act(async () => { await result.current.closePosition(100); });
    expect(entry()).toBe(0n);
  });
});
