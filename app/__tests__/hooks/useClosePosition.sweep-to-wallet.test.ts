import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// M-3: a v17/v18 close reads the market fresh for the ADL-effective quantity (real v18 bytes).
const MARKET_BYTES = Buffer.from(
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "5bVTTMRc.ansem.market.json"), "utf8")).dataBase64,
  "base64",
);

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

vi.mock("@/hooks/useUserAccount", () => ({
  useUserAccount: vi.fn(),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(),
}));

vi.mock("@/lib/priceStore/priceStore", () => ({
  getLivePriceSnapshot: mocks.getLivePriceSnapshot,
}));

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

vi.mock("@/lib/errorMessages", () => ({
  humanizeError: (message: string) => message,
  withTransientRetry: async (
    operation: () => Promise<unknown>,
  ) => operation(),
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

describe("useClosePosition — a FULL close moves the freed USDC back to the wallet (Squid 2026-10-01)", () => {
  const slabAddress = "11111111111111111111111111111111";
  const walletPublicKey = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const programId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  let closed = false;
  const openLeg = { active: true, side: 0, aBasis: 1_000_000_000_000_000n, epochSnap: 0n, basisPosQ: 2n };

  beforeEach(() => {
    vi.clearAllMocks();
    closed = false;
    mocks.trade.mockImplementation(async () => { closed = true; return "close-sig"; });
    mocks.withdraw.mockResolvedValue("withdraw-sig");
    mocks.isV17Account.mockReturnValue(true);
    mocks.getLivePriceSnapshot.mockReturnValue({ priceE6: 100_000_000n });
    mocks.getProgramAccounts.mockResolvedValue([{ pubkey: walletPublicKey, account: { data: Buffer.alloc(1) } }]);
    mocks.parsePortfolioV17.mockImplementation(() =>
      closed
        ? { owner: walletPublicKey, capital: 487_250_000n, legs: [{ ...openLeg, active: false }] }
        : { owner: walletPublicKey, capital: 500_000_000n, legs: [openLeg] },
    );
    vi.mocked(useConnectionCompat).mockReturnValue({
      connection: { getProgramAccounts: mocks.getProgramAccounts, getAccountInfo: async () => ({ data: MARKET_BYTES }) },
    } as ReturnType<typeof useConnectionCompat>);
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: walletPublicKey, connected: true } as ReturnType<typeof useWalletCompat>);
    vi.mocked(useTrade).mockReturnValue({ trade: mocks.trade } as unknown as ReturnType<typeof useTrade>);
    vi.mocked(useUserAccount).mockReturnValue({ idx: 7, account: { positionSize: 2n } } as ReturnType<typeof useUserAccount>);
    vi.mocked(useSlabState).mockReturnValue({
      accounts: [{ idx: 3, account: { kind: "LP" } }], raw: Buffer.from([1]), programId,
    } as unknown as ReturnType<typeof useSlabState>);
  });

  it("Close 100%: the close resolves, then the EXACT post-close capital is withdrawn", async () => {
    const { result } = renderHook(() => useClosePosition(slabAddress));
    let r: Awaited<ReturnType<typeof result.current.closePosition>> | undefined;
    await act(async () => { r = await result.current.closePosition(100); });
    expect(r?.signature).toBe("close-sig");
    await vi.waitFor(() => expect(mocks.withdraw).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(mocks.withdraw).toHaveBeenCalledWith({ userIdx: 7, amount: 487_250_000n });
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/back in your wallet/), "success"));
  });

  it("Move flow: skipSweep closes without the background withdraw (the Move withdraw step owns it)", async () => {
    const { result } = renderHook(() => useClosePosition(slabAddress));
    let r: Awaited<ReturnType<typeof result.current.closePosition>> | undefined;
    await act(async () => { r = await result.current.closePosition(100, { skipSweep: true }); });
    expect(r?.signature).toBe("close-sig");
    await new Promise((res) => setTimeout(res, 300));
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it("CONTROL: Close 50% never withdraws", async () => {
    const { result } = renderHook(() => useClosePosition(slabAddress));
    await act(async () => { await result.current.closePosition(50); });
    await new Promise((r) => setTimeout(r, 200));
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });

  it("a declined / failed withdraw never fails the close; the money is said to stay on the market", async () => {
    mocks.withdraw.mockRejectedValue(new Error("User rejected the request."));
    const { result } = renderHook(() => useClosePosition(slabAddress));
    let r: Awaited<ReturnType<typeof result.current.closePosition>> | undefined;
    await act(async () => { r = await result.current.closePosition(100); });
    expect(r?.signature).toBe("close-sig");
    expect(result.current.error).toBeNull();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringMatching(/stays on this market/), "info"), { timeout: 3000 });
  });
});
