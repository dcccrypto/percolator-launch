/**
 * v2.2 QA P-2: the withdraw refusal copy. Harness copied from useWithdraw-portfolio-fastpath.test.ts.
 * (original header follows)
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
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { WITHDRAW_OPEN_POSITIONS_MESSAGE, WITHDRAW_STALE_MESSAGE, engineStaleWithdrawMessage } from "@/lib/withdraw-copy";

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

describe("useWithdraw: Custom(19) and open-leg copy (v2.2 QA P-2)", () => {
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
    // The harness mocks the v2.1 portfolio parser (parsePortfolioV17); the copy under test is flag-independent.
    __setDevnetV22ForTest(false);
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

  it("an open leg is refused before signing with the calm close-first line", async () => {
    vi.mocked(parsePortfolioV17).mockReturnValue({ ...walletOwnedPortfolio(), legs: [{ active: true, basisPosQ: 5n }] } as any);
    const { result } = renderHook(() => useWithdraw(mockSlabAddress));
    await act(async () => {
      await result.current.withdraw({ userIdx: 1, amount: 1n, portfolioPk: fastPathPortfolioPk }).catch(() => {});
    });
    expect(sendTx).not.toHaveBeenCalled();
    expect(result.current.error).toBe(WITHDRAW_OPEN_POSITIONS_MESSAGE);
  });

  it("a Custom(19) on an account read as flat keeps the catching-up line (real staleness)", async () => {
    vi.mocked(sendTx).mockRejectedValue(new Error('failed: {"InstructionError":[0,{"Custom":19}]}'));
    const { result } = renderHook(() => useWithdraw(mockSlabAddress));
    await act(async () => {
      await result.current.withdraw({ userIdx: 1, amount: 1n, portfolioPk: fastPathPortfolioPk }).catch(() => {});
    });
    expect(sendTx).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe(WITHDRAW_STALE_MESSAGE);
  });

  it("copy QA item 11: a wallet-worded 19 (hex) on a flat account is the catching-up line, never 'close your open position first'", async () => {
    vi.mocked(sendTx).mockRejectedValue(new Error("Transaction simulation failed: Error processing Instruction 1: custom program error: 0x13"));
    const { result } = renderHook(() => useWithdraw(mockSlabAddress));
    await act(async () => {
      await result.current.withdraw({ userIdx: 1, amount: 1n, portfolioPk: fastPathPortfolioPk }).catch(() => {});
    });
    expect(result.current.error).toBe(WITHDRAW_STALE_MESSAGE);
    expect(result.current.error).not.toMatch(/close your open position first/i);
  });

  it("copy QA item 11 negative control: the same hex 19 with an open leg read still says close positions (true there)", async () => {
    // The open leg is caught before signing, so sendTx must not even be reached.
    vi.mocked(parsePortfolioV17).mockReturnValue({ ...walletOwnedPortfolio(), legs: [{ active: true, basisPosQ: 5n }] } as any);
    vi.mocked(sendTx).mockRejectedValue(new Error("custom program error: 0x13"));
    const { result } = renderHook(() => useWithdraw(mockSlabAddress));
    await act(async () => {
      await result.current.withdraw({ userIdx: 1, amount: 1n, portfolioPk: fastPathPortfolioPk }).catch(() => {});
    });
    expect(result.current.error).toBe(WITHDRAW_OPEN_POSITIONS_MESSAGE);
  });

  it("a Custom(19) when the portfolio could not be read says close positions (the engine's flat-only rule)", () => {
    expect(engineStaleWithdrawMessage(null)).toBe(WITHDRAW_OPEN_POSITIONS_MESSAGE);
    expect(engineStaleWithdrawMessage(true)).toBe(WITHDRAW_OPEN_POSITIONS_MESSAGE);
    expect(engineStaleWithdrawMessage(false)).toBe(WITHDRAW_STALE_MESSAGE);
    expect(WITHDRAW_OPEN_POSITIONS_MESSAGE).toBe("Close your positions before withdrawing.");
    expect(WITHDRAW_OPEN_POSITIONS_MESSAGE).not.toMatch(/mark|price|stale/i);
  });
});
