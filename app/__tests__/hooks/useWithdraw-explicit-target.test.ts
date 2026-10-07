/**
 * #2560: useWithdraw with an EXPLICIT portfolio target (the dock's ± Margin, the post-close
 * sweep of an isolated position).
 *
 * Rule under test (review of #3137 "refuse vs substitute"): an explicit NON-primary target is acted
 * on exactly or not at all. A transient read failure must never fall back to the wallet's primary
 * (cross) account and withdraw ITS collateral. The target must also be program-owned, this
 * wallet's and on THIS market. An explicit PRIMARY target (what the live DepositWithdrawCard
 * passes: userAccount.pubkey) keeps the original fall-back-to-scan behaviour, pinned by
 * useWithdraw-portfolio-fastpath.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWithdraw } from "../../hooks/useWithdraw";

vi.mock("@/hooks/useWalletCompat", () => ({ useConnectionCompat: vi.fn(), useWalletCompat: vi.fn() }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: vi.fn() }));
vi.mock("@/lib/tx", () => ({ sendTx: vi.fn() }));
vi.mock("@/lib/errorMessages", () => ({
  UserFacingError: class UserFacingError extends Error {},
  userFacingMessage: () => null,
  humanizeError: vi.fn((msg) => msg),
}));
vi.mock("@/lib/config", () => ({}));
vi.mock("@/lib/programAllowlist", () => ({ isKnownProgram: () => true, assertKnownProgram: () => {} }));
vi.mock("@/lib/lpPortfolio", () => ({ isLpPortfolio: () => false }));

const snapshot = vi.hoisted(() => ({ primary: undefined as { pubkey: unknown } | undefined }));
vi.mock("@/lib/userAccountScan", () => ({
  getPortfolioRawSnapshot: vi.fn(() => snapshot.primary),
  makePortfolioScanKey: vi.fn(() => "test-key"),
  isLpPortfolio: vi.fn(() => false),
}));

const mockVaultAuth = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
const mockOraclePda = new PublicKey("8DjWTsU1o8RHTKpRsqGFyYqFMknb8g7z2mjLfVYUyYyF");
vi.mock("@percolatorct/sdk", async () => {
  const actual = await vi.importActual("@percolatorct/sdk");
  return {
    ...actual,
    getAta: vi.fn(),
    deriveVaultAuthority: vi.fn(() => [mockVaultAuth, 255]),
    derivePythPushOraclePDA: vi.fn(() => [mockOraclePda, 255]),
    parsePortfolioV17: vi.fn(),
  };
});

import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";
import { getAta, parsePortfolioV17 } from "@percolatorct/sdk";

describe("useWithdraw: explicit non-primary target is exact-or-refuse", () => {
  const slabAddress = "11111111111111111111111111111111";
  const slabPk = new PublicKey(slabAddress);
  const wallet = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const programId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  const otherProgram = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const mint = new PublicKey("So11111111111111111111111111111111111111112");
  const isolatedPk = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
  const primaryPk = new PublicKey("2RJD1KnDRGEkvuFfAGrJ7PD28LRE9LRDjZznDywagzmr");

  const portfolio = (over: Record<string, unknown> = {}) => ({
    owner: wallet,
    marketGroupId: slabPk,
    legs: [],
    pnl: 0n,
    capital: 10_000_000n,
    portfolioId: 42n,
    matcherSequence: 7n,
    matcherPositionEpoch: 0n,
    ...over,
  });

  let conn: { getAccountInfo: ReturnType<typeof vi.fn>; getProgramAccounts: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    snapshot.primary = { pubkey: primaryPk }; // the store's primary (cross) account
    conn = {
      getAccountInfo: vi.fn().mockResolvedValue({ owner: programId, data: Buffer.alloc(1288) }),
      getProgramAccounts: vi.fn().mockResolvedValue([{ pubkey: primaryPk, account: { data: Buffer.alloc(1288) } }]),
    };
    vi.mocked(useConnectionCompat).mockReturnValue({ connection: conn } as never);
    vi.mocked(useWalletCompat).mockReturnValue({ publicKey: wallet, signTransaction: vi.fn(), connected: true } as never);
    vi.mocked(useSlabState).mockReturnValue({
      config: {
        collateralMint: mint,
        vaultPubkey: new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"),
        oracleAuthority: PublicKey.default,
        indexFeedId: new PublicKey(new Uint8Array(32).fill(1)),
        authorityPriceE6: 1000000n,
        lastEffectivePriceE6: 1000000n,
        invert: false,
      },
      wrapperConfigV17: { oracleMode: 0 },
      params: { initialMarginBps: 1000n },
      programId,
      refresh: vi.fn(),
    } as never);
    vi.mocked(sendTx).mockResolvedValue({ signature: "sig" } as never);
    vi.mocked(getAta).mockResolvedValue(new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1"));
    vi.mocked(parsePortfolioV17).mockReturnValue(portfolio() as never);
  });

  async function withdrawTo(target: PublicKey) {
    const { result } = renderHook(() => useWithdraw(slabAddress));
    let err: unknown = null;
    await act(async () => {
      try {
        await result.current.withdraw({ userIdx: 0, amount: 1n, portfolioPk: target });
      } catch (e) {
        err = e;
      }
    });
    return err as Error | null;
  }
  const sentTo = () => {
    const { instructions } = vi.mocked(sendTx).mock.calls[0][0];
    return instructions[instructions.length - 1].keys[2].pubkey;
  };

  it("a verified isolated target is used directly, with no scan", async () => {
    expect(await withdrawTo(isolatedPk)).toBeNull();
    expect(conn.getProgramAccounts).not.toHaveBeenCalled();
    expect(sentTo().equals(isolatedPk)).toBe(true);
  });

  it("REFUSES (nothing sent, no scan, never the primary) when the isolated target's read throws", async () => {
    conn.getAccountInfo.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    const err = await withdrawTo(isolatedPk);
    expect(err?.message).toMatch(/Couldn't confirm the selected account/);
    expect(sendTx).not.toHaveBeenCalled();
    expect(conn.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("REFUSES when the isolated target is missing", async () => {
    conn.getAccountInfo.mockResolvedValueOnce(null);
    expect((await withdrawTo(isolatedPk))?.message).toMatch(/Couldn't confirm/);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("REFUSES a target owned by another wallet", async () => {
    vi.mocked(parsePortfolioV17).mockReturnValue(portfolio({ owner: new PublicKey(new Uint8Array(32).fill(7)) }) as never);
    expect((await withdrawTo(isolatedPk))?.message).toMatch(/Couldn't confirm/);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("REFUSES a target that is not owned by the program", async () => {
    conn.getAccountInfo.mockResolvedValueOnce({ owner: otherProgram, data: Buffer.alloc(1288) });
    expect((await withdrawTo(isolatedPk))?.message).toMatch(/Couldn't confirm/);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("REFUSES a same-wallet portfolio of ANOTHER market (it would otherwise only fail on chain)", async () => {
    vi.mocked(parsePortfolioV17).mockReturnValue(portfolio({ marketGroupId: new PublicKey(new Uint8Array(32).fill(99)) }) as never);
    expect((await withdrawTo(isolatedPk))?.message).toMatch(/Couldn't confirm/);
    expect(sendTx).not.toHaveBeenCalled();
  });

  it("CONTROL: an explicit PRIMARY target (the live DepositWithdrawCard path) still falls back (to the store pick / scan) on a failed read, as before", async () => {
    conn.getAccountInfo.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    expect(await withdrawTo(primaryPk)).toBeNull();
    expect(sendTx).toHaveBeenCalledTimes(1);
    expect(sentTo().equals(primaryPk)).toBe(true);
  });
});
