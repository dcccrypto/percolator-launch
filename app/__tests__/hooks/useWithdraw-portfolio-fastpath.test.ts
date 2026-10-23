/**
 * useWithdraw v17 portfolio fast-path tests
 *
 * When the caller supplies params.portfolioPk (SlabProvider's userAccount),
 * useWithdraw takes a targeted getAccountInfo fast path instead of the GPA
 * scan. Review finding on PR #2407: a fetch failure/null result must RESET
 * portfolioPk so the GPA scan fallback runs — otherwise portfolioData stays
 * null, the M7 over-withdraw pre-check is skipped, and the crank-prepend
 * decision (hasActiveLegs) is silently wrong. The fast path must also
 * owner-verify the fetched account, mirroring the scan-store path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWithdraw } from "../../hooks/useWithdraw";

vi.mock("@/hooks/useWalletCompat", () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));

vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: vi.fn(),
}));

vi.mock("@/lib/tx", () => ({
  sendTx: vi.fn(),
}));

vi.mock("@/lib/errorMessages", () => ({
  UserFacingError: class UserFacingError extends Error {},
  userFacingMessage: () => null,
  humanizeError: vi.fn((msg) => msg),
}));

vi.mock("@/lib/config", () => ({
}));

vi.mock("@/lib/programAllowlist", () => ({
  isKnownProgram: () => true,
  assertKnownProgram: () => {},
}));

// The scan-store snapshot must miss so the only paths in play are the
// caller-supplied fast path and the GPA scan fallback.
vi.mock("@/lib/userAccountScan", () => ({
  getPortfolioRawSnapshot: vi.fn(() => undefined),
  makePortfolioScanKey: vi.fn(() => "test-key"),
  isLpPortfolio: vi.fn(() => false),
}));

const mockVaultAuth = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
const mockOraclePda = new PublicKey("8DjWTsU1o8RHTKpRsqGFyYqFMknb8g7z2mjLfVYUyYyF");

// The hook decodes portfolios through lib/v22/layout (flag off it delegates to the SDK parser, flag on it is VERSION-keyed): route that seam to the
// same mocked parsePortfolioV17 so the fixtures below mean the same thing in every mode.
vi.mock("@/lib/v22/layout", async (orig) => ({
  ...(await orig<object>()),
  parsePortfolio: (...a: Parameters<typeof parsePortfolioV17>) => parsePortfolioV17(...a),
}));

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

describe("useWithdraw v17 portfolio fast path", () => {
  const mockSlabAddress = "11111111111111111111111111111111";
  const mockWalletPubkey = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
  const mockProgramId = new PublicKey("5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf");
  const mockCollateralMint = new PublicKey("So11111111111111111111111111111111111111112");
  const mockVault = new PublicKey("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
  const mockUserAta = new PublicKey("DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1");
  const fastPathPortfolioPk = new PublicKey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");
  const scannedPortfolioPk = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

  let mockConnection: any;
  let mockWallet: any;
  let mockSlabState: any;

  // portfolioId / matcherSequence / matcherPositionEpoch: since 0d975d00 (v18
  // anti-replay wire) the withdraw ix binds the portfolio's identity, read via
  // parsePortfolioV17 (lib/v18-wire.ts readPortfolioIdentity). The mocked parse
  // must carry them or encodeWithdrawCollateral rejects `undefined`.
  const walletOwnedPortfolio = () => ({
    owner: mockWalletPubkey,
    legs: [],
    pnl: 0n,
    capital: 10_000_000n,
    portfolioId: 42n,
    matcherSequence: 7n,
    matcherPositionEpoch: 0n,
  });

  beforeEach(() => {
    vi.clearAllMocks();

    mockConnection = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: Buffer.alloc(1288) }),
      getProgramAccounts: vi.fn().mockResolvedValue([
        { pubkey: scannedPortfolioPk, account: { data: Buffer.alloc(1288) } },
      ]),
    };

    mockWallet = {
      publicKey: mockWalletPubkey,
      signTransaction: vi.fn(),
      connected: true,
    };

    mockSlabState = {
      config: {
        collateralMint: mockCollateralMint,
        vaultPubkey: mockVault,
        oracleAuthority: PublicKey.default,
        indexFeedId: new PublicKey(new Uint8Array(32).fill(1)),
        authorityPriceE6: 1000000n,
        lastEffectivePriceE6: 1000000n,
        invert: false,
      },
      // Non-null → v17 path, network re-check skipped.
      wrapperConfigV17: { oracleMode: 0 },
      params: { initialMarginBps: 1000n },
      programId: mockProgramId,
      refresh: vi.fn(),
    };

    vi.mocked(useConnectionCompat).mockReturnValue({ connection: mockConnection });
    vi.mocked(useWalletCompat).mockReturnValue(mockWallet);
    vi.mocked(useSlabState).mockReturnValue(mockSlabState);
    vi.mocked(sendTx).mockResolvedValue({ signature: "mock-signature" } as any);
    vi.mocked(getAta).mockResolvedValue(mockUserAta);
    vi.mocked(parsePortfolioV17).mockReturnValue(walletOwnedPortfolio() as any);
  });

  it("uses the caller-supplied portfolioPk without a GPA scan when fetch + owner check succeed", async () => {
    const { result } = renderHook(() => useWithdraw(mockSlabAddress));

    await act(async () => {
      await result.current.withdraw({ userIdx: 1, amount: 1n, portfolioPk: fastPathPortfolioPk });
    });

    expect(mockConnection.getAccountInfo).toHaveBeenCalledWith(fastPathPortfolioPk, "confirmed");
    expect(mockConnection.getProgramAccounts).not.toHaveBeenCalled();
    expect(sendTx).toHaveBeenCalledTimes(1);
    // Withdraw ix must target the fast-path portfolio.
    const { instructions } = vi.mocked(sendTx).mock.calls[0][0];
    const withdrawIx = instructions[instructions.length - 1];
    expect(withdrawIx.keys[2].pubkey.equals(fastPathPortfolioPk)).toBe(true);
    // v18 wire: [tag u8][portfolioId u64][expectedSequence u64][amount u128].
    const data = Buffer.from(withdrawIx.data);
    expect(data.readBigUInt64LE(1)).toBe(42n);
    expect(data.readBigUInt64LE(9)).toBe(7n);
  });

  it("falls back to the GPA scan when the fast-path fetch throws", async () => {
    mockConnection.getAccountInfo.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    const { result } = renderHook(() => useWithdraw(mockSlabAddress));

    await act(async () => {
      await result.current.withdraw({ userIdx: 1, amount: 1n, portfolioPk: fastPathPortfolioPk });
    });

    expect(mockConnection.getProgramAccounts).toHaveBeenCalledTimes(1);
    const { instructions } = vi.mocked(sendTx).mock.calls[0][0];
    const withdrawIx = instructions[instructions.length - 1];
    expect(withdrawIx.keys[2].pubkey.equals(scannedPortfolioPk)).toBe(true);
  });

  it("falls back to the GPA scan when the fast-path account is missing (null)", async () => {
    mockConnection.getAccountInfo.mockResolvedValueOnce(null);

    const { result } = renderHook(() => useWithdraw(mockSlabAddress));

    await act(async () => {
      await result.current.withdraw({ userIdx: 1, amount: 1n, portfolioPk: fastPathPortfolioPk });
    });

    expect(mockConnection.getProgramAccounts).toHaveBeenCalledTimes(1);
    const { instructions } = vi.mocked(sendTx).mock.calls[0][0];
    const withdrawIx = instructions[instructions.length - 1];
    expect(withdrawIx.keys[2].pubkey.equals(scannedPortfolioPk)).toBe(true);
  });

  it("falls back to the GPA scan when the fast-path account is owned by a different wallet", async () => {
    const otherOwner = new PublicKey(new Uint8Array(32).fill(7));
    vi.mocked(parsePortfolioV17)
      .mockReturnValueOnce({ ...walletOwnedPortfolio(), owner: otherOwner } as any) // fast path: mismatch
      .mockReturnValue(walletOwnedPortfolio() as any); // scan path + M7 check

    const { result } = renderHook(() => useWithdraw(mockSlabAddress));

    await act(async () => {
      await result.current.withdraw({ userIdx: 1, amount: 1n, portfolioPk: fastPathPortfolioPk });
    });

    expect(mockConnection.getProgramAccounts).toHaveBeenCalledTimes(1);
    const { instructions } = vi.mocked(sendTx).mock.calls[0][0];
    const withdrawIx = instructions[instructions.length - 1];
    expect(withdrawIx.keys[2].pubkey.equals(scannedPortfolioPk)).toBe(true);
  });

  it("runs the M7 over-withdraw pre-check on fast-path data (amount > capital rejects client-side)", async () => {
    const { result } = renderHook(() => useWithdraw(mockSlabAddress));

    await act(async () => {
      await expect(
        result.current.withdraw({
          userIdx: 1,
          amount: 999_999_999_999n, // way past capital (10_000_000n), no open legs
          portfolioPk: fastPathPortfolioPk,
        }),
      ).rejects.toThrow(/exceeds your account balance/);
    });

    expect(sendTx).not.toHaveBeenCalled();
  });
});
