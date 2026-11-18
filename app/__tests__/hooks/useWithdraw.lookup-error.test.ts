/**
 * useWithdraw v17: a failed owner-portfolio scan (429/timeout) must NOT read as "no account".
 * Only a scan that completed and found nothing shows the "Deposit first" copy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWithdraw, isThisMarketsTraderPortfolio } from "../../hooks/useWithdraw";
import { isPortfolioLookupError } from "@/lib/owner-portfolio";

vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: vi.fn(), useWalletCompat: vi.fn() }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: vi.fn() }));
vi.mock("@/lib/tx", () => ({ sendTx: vi.fn() }));
vi.mock("@/lib/programAllowlist", () => ({ isKnownProgram: () => true, assertKnownProgram: () => {} }));
vi.mock("@/lib/userAccountScan", () => ({
  getPortfolioRawSnapshot: vi.fn(() => undefined),
  makePortfolioScanKey: vi.fn(() => "k"),
  isLpPortfolio: vi.fn(() => false),
}));
vi.mock("@/lib/owner-portfolio", async (orig) => {
  const actual = await orig<typeof import("@/lib/owner-portfolio")>();
  // no real 400/1200ms backoff in tests
  return { ...actual, scanOwnerPortfolios: (c: any, p: any, m: any, o: any) => actual.scanOwnerPortfolios(c, p, m, o, { sleep: async () => {} }) };
});
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual("@percolatorct/sdk");
  return { ...actual, getAta: vi.fn(), deriveVaultAuthority: vi.fn(() => [PublicKey.default, 255]) };
});

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";
import { getAta } from "@percolatorct/sdk";

describe("useWithdraw v17 lookup failure", () => {
  const slab = "11111111111111111111111111111111";
  const wallet = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const programId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  let conn: any;

  beforeEach(() => {
    vi.clearAllMocks();
    conn = { getAccountInfo: vi.fn().mockResolvedValue(null), getProgramAccounts: vi.fn() };
    vi.mocked(useConnectionCompat).mockReturnValue({ connection: conn } as any);
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: wallet, signTransaction: vi.fn(), connected: true } as any);
    vi.mocked(useSlabState).mockReturnValue({
      config: { collateralMint: wallet, vaultPubkey: wallet, oracleAuthority: PublicKey.default, indexFeedId: PublicKey.default, authorityPriceE6: 1n, lastEffectivePriceE6: 1n, invert: false },
      wrapperConfigV17: { oracleMode: 0 },
      params: { initialMarginBps: 1000n },
      programId,
      refresh: vi.fn(),
    } as any);
    vi.mocked(getAta).mockResolvedValue(wallet);
  });

  it("scan rejects, no store snapshot -> PortfolioLookupError, not 'No account found'", async () => {
    conn.getProgramAccounts.mockRejectedValue(new Error("429 Too Many Requests"));
    const { result } = renderHook(() => useWithdraw(slab));
    let thrown: unknown;
    await act(async () => {
      try { await result.current.withdraw({ userIdx: 1, amount: 1n }); } catch (e) { thrown = e; }
    });
    expect(isPortfolioLookupError(thrown)).toBe(true);
    expect(String((thrown as Error).message)).not.toContain("No account found");
    expect(conn.getProgramAccounts).toHaveBeenCalledTimes(3);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("scan completes with no accounts -> 'Deposit first' copy", async () => {
    conn.getProgramAccounts.mockResolvedValue([]);
    const { result } = renderHook(() => useWithdraw(slab));
    let thrown: unknown;
    await act(async () => {
      try { await result.current.withdraw({ userIdx: 1, amount: 1n }); } catch (e) { thrown = e; }
    });
    expect(isPortfolioLookupError(thrown)).toBe(false);
    expect(String((thrown as Error).message)).toContain("Deposit first");
  });

  it("fast/store-path guard: rejects another market's portfolio and the LP portfolio", async () => {
    const { isLpPortfolio } = await import("@/lib/userAccountScan");
    const market = new PublicKey(new Uint8Array(32).fill(9));
    const mine = Buffer.alloc(1288);
    Buffer.from(market.toBytes()).copy(mine, 16);
    expect(isThisMarketsTraderPortfolio(mine, market)).toBe(true);
    expect(isThisMarketsTraderPortfolio(mine, new PublicKey(new Uint8Array(32).fill(8)))).toBe(false);
    vi.mocked(isLpPortfolio).mockReturnValueOnce(true);
    expect(isThisMarketsTraderPortfolio(mine, market)).toBe(false);
  });
});
