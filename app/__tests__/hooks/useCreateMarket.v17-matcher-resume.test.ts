import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

const mocks = vi.hoisted(() => ({
  sendTx: vi.fn(),
  getAccountInfo: vi.fn(),
  getProgramAccounts: vi.fn(),
  getAccount: vi.fn(),
  updateInFlightStep: vi.fn(),
  deriveVaultAuthority: vi.fn(),
  deriveMatcherDelegate: vi.fn(),

  connection: null as unknown as Record<string, unknown>,
  wallet: null as unknown as Record<string, unknown>,
  config: null as unknown as Record<string, unknown>,
  getAssociatedTokenAddress: vi.fn(),
}));

vi.mock('@/hooks/useWalletCompat', () => ({
  useConnectionCompat: () => ({
    connection: mocks.connection,
  }),
  useWalletCompat: () => mocks.wallet,
}));

vi.mock('@/lib/tx', () => ({
  sendTx: mocks.sendTx,
}));

vi.mock('@/lib/config', () => ({
  getConfig: () => mocks.config,
  // Mainnet forces the insufficient-balance path to stop execution
  // immediately after Step 2, without calling the pre-fund endpoint.
  getNetwork: () => 'mainnet',
}));

vi.mock('@/lib/inFlightMarket', () => ({
  saveInFlightMarket: vi.fn(),
  updateInFlightStep: mocks.updateInFlightStep,
  clearInFlightMarket: vi.fn(),
  loadLastInFlightMarket: vi.fn(() => null),
}));

vi.mock('@solana/spl-token', async () => {
  const actual = await vi.importActual<typeof import('@solana/spl-token')>('@solana/spl-token');

  return {
    ...actual,
    getAccount: mocks.getAccount,
    getAssociatedTokenAddress: mocks.getAssociatedTokenAddress,
  };
});

vi.mock('@percolatorct/sdk', async () => {
  const actual = await vi.importActual<typeof import('@percolatorct/sdk')>('@percolatorct/sdk');

  return {
    ...actual,
    deriveVaultAuthority: mocks.deriveVaultAuthority,
    deriveMatcherDelegate: mocks.deriveMatcherDelegate,
  };
});

import { useCreateMarket } from '@/hooks/useCreateMarket';

describe('useCreateMarket v17 matcher resume PoC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deriveMatcherDelegate.mockReset();

    mocks.getAssociatedTokenAddress.mockReset();
    mocks.getAssociatedTokenAddress.mockResolvedValue(new PublicKey(new Uint8Array(32).fill(24)));

    const walletKeypair = Keypair.generate();
    const programId = new PublicKey('69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9');
    const matcherProgramId = new PublicKey('4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT');

    mocks.connection = {
      getAccountInfo: mocks.getAccountInfo,
      getProgramAccounts: mocks.getProgramAccounts,
    };

    mocks.wallet = {
      publicKey: walletKeypair.publicKey,
      connected: true,
      connecting: false,
      signTransaction: vi.fn(async (tx) => tx),
      signAllTransactions: vi.fn(async (txs) => txs),
      signMessage: vi.fn(),
      disconnect: vi.fn(),
    };

    mocks.config = {
      programId: programId.toBase58(),
      matcherProgramId: matcherProgramId.toBase58(),
      programsBySlabTier: undefined,
    };

    mocks.sendTx.mockResolvedValue('mock-signature');

    mocks.deriveVaultAuthority.mockReturnValue([new PublicKey(new Uint8Array(32).fill(23)), 255]);

    // Stop execution at the beginning of Step 3. This isolates Step 2:
    // no deposit, insurance, or crank transaction can be submitted.
    mocks.getAccount.mockResolvedValue({
      amount: 0n,
    });
  });

  it('fails closed when a disabled v17 matcher config contains committed fields', async () => {
    const walletPublicKey = (
      mocks.wallet as {
        publicKey: PublicKey;
      }
    ).publicKey;

    const programId = new PublicKey((mocks.config as { programId: string }).programId);

    const slabKeypair = Keypair.fromSeed(new Uint8Array(32).fill(31));
    const lpPortfolioKeypair = Keypair.generate();
    const mint = Keypair.generate().publicKey;

    // V17 magic used by the production account-discovery path:
    // [00, 36, 31, 56, 43, 52, 45, 50].
    const v17Magic = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
    const v17Version = 17; // SDK 4.2.0: V17_EXPECTED_VERSION bumped 16 -> 17 (deployed markets are v17)
    // A v17 market/slab response so create(params, 2) enters
    // the v17 matcher-initialization branch.
    const slabData = Buffer.alloc(26_364);
    v17Magic.copy(slabData, 0);
    slabData.writeUInt16LE(v17Version, 8);
    mocks.getAccountInfo.mockResolvedValue({
      data: slabData,
      executable: false,
      lamports: 1,
      owner: programId,
      rentEpoch: 0,
    });

    // Existing LP portfolio:
    // - same market at offset 16;
    // - same mutable owner at offset 80;
    // - remaining bytes zeroed, including matcher config enabled state.
    //
    // This models TX A having landed while TX C / TX D did not.
    const lpPortfolioData = Buffer.alloc(9_347);
    v17Magic.copy(lpPortfolioData, 0);
    lpPortfolioData.writeUInt16LE(v17Version, 8);
    slabKeypair.publicKey.toBuffer().copy(lpPortfolioData, 16);
    walletPublicKey.toBuffer().copy(lpPortfolioData, 80);

    // Prove that the mocked account matches the same identity fields
    // used by the production getProgramAccounts lookup.
    expect(lpPortfolioData).toHaveLength(9_347);
    expect(lpPortfolioData.subarray(0, 8)).toEqual(v17Magic);
    expect(lpPortfolioData.subarray(16, 48)).toEqual(slabKeypair.publicKey.toBuffer());
    expect(lpPortfolioData.subarray(80, 112)).toEqual(walletPublicKey.toBuffer());

    // PortfolioMatcherConfigV16 occupies the final 104 bytes:
    // matcher_program[32] + matcher_context[32] +
    // matcher_delegate[32] + enabled[u64].
    const matcherConfigOffset = lpPortfolioData.length - 104;
    expect(matcherConfigOffset).toBe(9_243);
    expect(lpPortfolioData.subarray(matcherConfigOffset, matcherConfigOffset + 96)).toEqual(
      Buffer.alloc(96),
    );
    expect(lpPortfolioData.readBigUInt64LE(matcherConfigOffset + 96)).toBe(0n);

    // A disabled-but-non-empty configuration is inconsistent and must not
    // be silently overwritten during recovery.
    lpPortfolioData[matcherConfigOffset] = 1;

    mocks.getProgramAccounts.mockResolvedValue([
      {
        pubkey: lpPortfolioKeypair.publicKey,
        account: {
          data: lpPortfolioData,
          executable: false,
          lamports: 1,
          owner: programId,
          rentEpoch: 0,
        },
      },
    ]);

    const { result } = renderHook(() => useCreateMarket());

    act(() => {
      result.current.restoreSlabKeypair(slabKeypair, slabKeypair.publicKey.toBase58());
    });

    await act(async () => {
      await result.current.create(
        {
          mint,
          initialPriceE6: 100_000_000n,
          lpCollateral: 1_000_000n,
          insuranceAmount: 100_000n,
          oracleFeed: '0'.repeat(64),
          invert: false,
          tradingFeeBps: 10,
          initialMarginBps: 1_500,
          maxAccounts: 4_096,
          decimals: 6,
          symbol: 'TEST',
          name: 'Test Market',
          oracleMode: 'admin',
        },
        2,
      );
    });

    const deriveCall = mocks.deriveVaultAuthority.mock.calls[0];

    expect(deriveCall).toBeDefined();
    expect((deriveCall[0] as PublicKey).toBase58()).toBe(programId.toBase58());
    expect((deriveCall[1] as PublicKey).toBase58()).toBe(slabKeypair.publicKey.toBase58());

    const actualSdk =
      await vi.importActual<typeof import('@percolatorct/sdk')>('@percolatorct/sdk');

    const slabHeaderHex = slabData.subarray(0, 10).toString('hex');

    const slabRecognizedByActualSdk = actualSdk.isV17Account(new Uint8Array(slabData));

    expect(slabHeaderHex).toBe('00363156435245501100');
    expect(slabRecognizedByActualSdk).toBe(true);

    // The existing LP lookup must occur before matcher readiness is evaluated.
    expect(mocks.getProgramAccounts).toHaveBeenCalledTimes(1);

    // Incomplete matcher state must not submit later-stage transactions.
    expect(mocks.sendTx).not.toHaveBeenCalled();

    // Recovery must not mark Step 2 complete unless matcher initialization
    // is verified from authoritative on-chain state.
    expect(mocks.updateInFlightStep).not.toHaveBeenCalledWith(slabKeypair.publicKey.toBase58(), 3);

    expect(result.current.state.step).toBe(2);

    expect(result.current.state.error).toMatch(
      /incomplete matcher initialization|cannot safely advance past step 2/i,
    );
  });

  it('advances past Step 2 only when an existing v17 LP matcher is fully initialized', async () => {
    const walletPublicKey = (
      mocks.wallet as {
        publicKey: PublicKey;
      }
    ).publicKey;

    const programId = new PublicKey(
      (
        mocks.config as {
          programId: string;
        }
      ).programId,
    );

    const matcherProgramId = new PublicKey(
      (
        mocks.config as {
          matcherProgramId: string;
        }
      ).matcherProgramId,
    );

    const slabKeypair = Keypair.fromSeed(new Uint8Array(32).fill(32));

    const lpPortfolioKeypair = Keypair.generate();
    const matcherContextKeypair = Keypair.generate();
    const mint = Keypair.generate().publicKey;

    const actualSdk =
      await vi.importActual<typeof import('@percolatorct/sdk')>('@percolatorct/sdk');

    const expectedDelegate = new PublicKey(new Uint8Array(32).fill(26));

    mocks.deriveMatcherDelegate.mockReturnValue([expectedDelegate, 255]);

    // Valid v17 slab fixture.
    const v17Magic = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

    const v17Version = 17; // SDK 4.2.0: V17_EXPECTED_VERSION bumped 16 -> 17 (deployed markets are v17)
    const slabData = Buffer.alloc(26_364);

    v17Magic.copy(slabData, 0);
    slabData.writeUInt16LE(v17Version, 8);

    const slabAccount = {
      data: slabData,
      executable: false,
      lamports: 1,
      owner: programId,
      rentEpoch: 0,
    };

    // Existing LP portfolio with a complete and enabled matcher config.
    const lpPortfolioData = Buffer.alloc(actualSdk.V17_PORTFOLIO_ACCOUNT_LEN);

    v17Magic.copy(lpPortfolioData, 0);
    lpPortfolioData.writeUInt16LE(v17Version, 8);

    slabKeypair.publicKey.toBuffer().copy(lpPortfolioData, 16);

    walletPublicKey.toBuffer().copy(lpPortfolioData, 80);

    const matcherConfigOffset = lpPortfolioData.length - 104;

    matcherProgramId.toBuffer().copy(lpPortfolioData, matcherConfigOffset);

    matcherContextKeypair.publicKey.toBuffer().copy(lpPortfolioData, matcherConfigOffset + 32);

    expectedDelegate.toBuffer().copy(lpPortfolioData, matcherConfigOffset + 64);

    lpPortfolioData.writeBigUInt64LE(1n, matcherConfigOffset + 96);

    // Initialized matcher context:
    // the wrapper delegate PDA is stored at CTX_VAMM_OFFSET.
    const matcherContextData = Buffer.alloc(actualSdk.MATCHER_CONTEXT_LEN);

    expectedDelegate.toBuffer().copy(matcherContextData, actualSdk.CTX_VAMM_OFFSET + 16);

    mocks.getAccountInfo.mockReset();

    mocks.getAccountInfo
      // Initial Step 2 slab lookup.
      .mockResolvedValueOnce(slabAccount)
      // Matcher-context readiness lookup.
      .mockResolvedValueOnce({
        data: matcherContextData,
        executable: false,
        lamports: 1,
        owner: matcherProgramId,
        rentEpoch: 0,
      })
      // Later Step 3 slab re-read.
      .mockResolvedValue(slabAccount);

    mocks.getProgramAccounts.mockResolvedValue([
      {
        pubkey: lpPortfolioKeypair.publicKey,
        account: {
          data: lpPortfolioData,
          executable: false,
          lamports: 1,
          owner: programId,
          rentEpoch: 0,
        },
      },
    ]);

    const { result } = renderHook(() => useCreateMarket());

    act(() => {
      result.current.restoreSlabKeypair(slabKeypair, slabKeypair.publicKey.toBase58());
    });

    await act(async () => {
      await result.current.create(
        {
          mint,
          initialPriceE6: 100_000_000n,
          lpCollateral: 1_000_000n,
          insuranceAmount: 100_000n,
          oracleFeed: '0'.repeat(64),
          invert: false,
          tradingFeeBps: 10,
          initialMarginBps: 1_500,
          maxAccounts: 4_096,
          decimals: 6,
          symbol: 'TEST',
          name: 'Test Market',
          oracleMode: 'admin',
        },
        2,
      );
    });

    expect(mocks.getProgramAccounts).toHaveBeenCalledTimes(1);

    expect(mocks.deriveMatcherDelegate).toHaveBeenCalledWith(
      programId,
      slabKeypair.publicKey,
      lpPortfolioKeypair.publicKey,
      walletPublicKey,
      matcherProgramId,
      matcherContextKeypair.publicKey,
    );

    expect(mocks.getAccountInfo).toHaveBeenCalledWith(matcherContextKeypair.publicKey);

    // A verified matcher must not cause TX A-D to be repeated.
    expect(mocks.sendTx).not.toHaveBeenCalled();

    // The persisted recovery marker may advance only after
    // authoritative matcher readiness validation succeeds.
    expect(mocks.updateInFlightStep).toHaveBeenCalledWith(slabKeypair.publicKey.toBase58(), 3);
  });
});
