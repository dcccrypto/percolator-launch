import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';

const mocks = vi.hoisted(() => ({
  sendTx: vi.fn(),
  getAccountInfo: vi.fn(),
  getProgramAccounts: vi.fn(),
  getMinimumBalanceForRentExemption: vi.fn(),
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

describe('useCreateMarket v17 matcher recovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.getMinimumBalanceForRentExemption.mockReset();
    mocks.getMinimumBalanceForRentExemption.mockResolvedValue(1_000_000);
    mocks.deriveMatcherDelegate.mockReset();

    mocks.getAssociatedTokenAddress.mockReset();
    mocks.getAssociatedTokenAddress.mockResolvedValue(new PublicKey(new Uint8Array(32).fill(24)));

    const walletKeypair = Keypair.generate();
    const programId = new PublicKey('69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9');
    const matcherProgramId = new PublicKey('4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT');

    mocks.connection = {
      getAccountInfo: mocks.getAccountInfo,
      getProgramAccounts: mocks.getProgramAccounts,
      getMinimumBalanceForRentExemption: mocks.getMinimumBalanceForRentExemption,
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

  const createParams = (mint: PublicKey) => ({
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
    oracleMode: 'admin' as const,
  });

  const makeAccount = (data: Buffer, owner: PublicKey) => ({
    data,
    executable: false,
    lamports: 1,
    owner,
    rentEpoch: 0,
  });

  it('resumes TX B-D when the existing LP matcher config is empty', async () => {
    const actualSdk =
      await vi.importActual<typeof import('@percolatorct/sdk')>('@percolatorct/sdk');

    const walletPublicKey = (mocks.wallet as { publicKey: PublicKey }).publicKey;

    const programId = new PublicKey((mocks.config as { programId: string }).programId);

    const matcherProgramId = new PublicKey(
      (mocks.config as { matcherProgramId: string }).matcherProgramId,
    );

    const slabKeypair = Keypair.fromSeed(new Uint8Array(32).fill(41));

    const lpPortfolioKeypair = Keypair.generate();
    const mint = Keypair.generate().publicKey;

    const v17Magic = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

    const slabData = Buffer.alloc(26_364);
    v17Magic.copy(slabData, 0);
    slabData.writeUInt16LE(16, 8);

    const slabAccount = makeAccount(slabData, programId);

    const emptyPortfolioData = Buffer.alloc(actualSdk.V17_PORTFOLIO_ACCOUNT_LEN);

    v17Magic.copy(emptyPortfolioData, 0);
    emptyPortfolioData.writeUInt16LE(16, 8);

    slabKeypair.publicKey.toBuffer().copy(emptyPortfolioData, 16);

    walletPublicKey.toBuffer().copy(emptyPortfolioData, 80);

    mocks.getProgramAccounts.mockResolvedValue([
      {
        pubkey: lpPortfolioKeypair.publicKey,
        account: makeAccount(emptyPortfolioData, programId),
      },
    ]);

    const expectedDelegate = new PublicKey(new Uint8Array(32).fill(42));

    let recoveredContextPk: PublicKey | null = null;

    mocks.deriveMatcherDelegate.mockImplementation((...args: unknown[]) => {
      recoveredContextPk = args[5] as PublicKey;
      return [expectedDelegate, 255];
    });

    const actualWeb3ForSystemProgram =
      await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');

    const createMatcherAccountSpy = vi
      .spyOn(actualWeb3ForSystemProgram.SystemProgram, 'createAccount')
      .mockImplementation(
        () =>
          new actualWeb3ForSystemProgram.TransactionInstruction({
            keys: [],
            programId: actualWeb3ForSystemProgram.SystemProgram.programId,
            data: Buffer.alloc(0),
          }),
      );

    mocks.sendTx
      .mockResolvedValueOnce('matcher-context-created')
      .mockResolvedValueOnce('matcher-config-stored')
      .mockResolvedValueOnce('matcher-context-initialized');

    mocks.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(slabKeypair.publicKey)) {
        return slabAccount;
      }

      if (pubkey.equals(lpPortfolioKeypair.publicKey)) {
        if (!recoveredContextPk) {
          throw new Error('Recovered context was not derived before verification');
        }

        const recoveredPortfolioData = Buffer.from(emptyPortfolioData);

        const configOffset = recoveredPortfolioData.length - 104;

        matcherProgramId.toBuffer().copy(recoveredPortfolioData, configOffset);

        recoveredContextPk.toBuffer().copy(recoveredPortfolioData, configOffset + 32);

        expectedDelegate.toBuffer().copy(recoveredPortfolioData, configOffset + 64);

        recoveredPortfolioData.writeBigUInt64LE(1n, configOffset + 96);

        return makeAccount(recoveredPortfolioData, programId);
      }

      if (recoveredContextPk && pubkey.equals(recoveredContextPk)) {
        const matcherContextData = Buffer.alloc(actualSdk.MATCHER_CONTEXT_LEN);

        expectedDelegate.toBuffer().copy(matcherContextData, actualSdk.CTX_VAMM_OFFSET);

        return makeAccount(matcherContextData, matcherProgramId);
      }

      return null;
    });

    // create(params, 2) continues into Step 3 after successful recovery.
    // Stop deliberately before any Step 3 transaction is submitted.
    const { result } = renderHook(() => useCreateMarket());

    act(() => {
      result.current.restoreSlabKeypair(slabKeypair, slabKeypair.publicKey.toBase58());
    });

    await act(async () => {
      await result.current.create(createParams(mint), 2);
    });

    expect(createMatcherAccountSpy).toHaveBeenCalledTimes(1);

    const createMatcherAccountParams = createMatcherAccountSpy.mock.calls[0]?.[0];

    expect(createMatcherAccountParams).toBeDefined();

    expect(createMatcherAccountParams?.fromPubkey.equals(walletPublicKey)).toBe(true);

    expect(
      createMatcherAccountParams?.newAccountPubkey.equals(recoveredContextPk as PublicKey),
    ).toBe(true);

    expect(createMatcherAccountParams?.programId.equals(matcherProgramId)).toBe(true);

    expect(createMatcherAccountParams?.lamports).toBe(1_000_000);

    expect(createMatcherAccountParams?.space).toBe(actualSdk.MATCHER_CONTEXT_LEN);

    // Step 2 recovery completed successfully. The zero-balance fixture
    // stops the flow before any Step 3 deposit transaction is submitted.
    expect(result.current.state.error).toContain('Insufficient token balance for deposit');

    expect(mocks.sendTx).toHaveBeenCalledTimes(3);

    const calls = mocks.sendTx.mock.calls.map(
      ([request]) =>
        request as {
          instructions: Array<{
            data: Uint8Array;
            programId: PublicKey;
          }>;
          signers?: Keypair[];
        },
    );

    // TX A must not be repeated. The first recovery transaction is TX B.
    expect(calls[0]?.instructions).toHaveLength(1);
    expect(calls[0]?.signers).toHaveLength(1);

    expect(calls[0]?.signers?.[0]?.publicKey.equals(recoveredContextPk as PublicKey)).toBe(true);

    // TX C and TX D retain their wrapper instruction tags.
    expect(calls[1]?.instructions[0]?.data[0]).toBe(68);
    expect(calls[2]?.instructions[0]?.data[0]).toBe(83);

    expect(mocks.updateInFlightStep).toHaveBeenCalledWith(slabKeypair.publicKey.toBase58(), 3);
  });

  it('resumes TX D only when the committed matcher context is uninitialized', async () => {
    const actualSdk =
      await vi.importActual<typeof import('@percolatorct/sdk')>('@percolatorct/sdk');

    const walletPublicKey = (mocks.wallet as { publicKey: PublicKey }).publicKey;

    const programId = new PublicKey((mocks.config as { programId: string }).programId);

    const matcherProgramId = new PublicKey(
      (mocks.config as { matcherProgramId: string }).matcherProgramId,
    );

    const slabKeypair = Keypair.fromSeed(new Uint8Array(32).fill(43));

    const lpPortfolioKeypair = Keypair.generate();
    const matcherContextKeypair = Keypair.generate();
    const mint = Keypair.generate().publicKey;

    const expectedDelegate = new PublicKey(new Uint8Array(32).fill(44));

    mocks.deriveMatcherDelegate.mockReturnValue([expectedDelegate, 255]);

    const v17Magic = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

    const slabData = Buffer.alloc(26_364);
    v17Magic.copy(slabData, 0);
    slabData.writeUInt16LE(16, 8);

    const slabAccount = makeAccount(slabData, programId);

    const portfolioData = Buffer.alloc(actualSdk.V17_PORTFOLIO_ACCOUNT_LEN);

    v17Magic.copy(portfolioData, 0);
    portfolioData.writeUInt16LE(16, 8);

    slabKeypair.publicKey.toBuffer().copy(portfolioData, 16);

    walletPublicKey.toBuffer().copy(portfolioData, 80);

    const configOffset = portfolioData.length - 104;

    matcherProgramId.toBuffer().copy(portfolioData, configOffset);

    matcherContextKeypair.publicKey.toBuffer().copy(portfolioData, configOffset + 32);

    expectedDelegate.toBuffer().copy(portfolioData, configOffset + 64);

    portfolioData.writeBigUInt64LE(1n, configOffset + 96);

    mocks.getProgramAccounts.mockResolvedValue([
      {
        pubkey: lpPortfolioKeypair.publicKey,
        account: makeAccount(portfolioData, programId),
      },
    ]);

    let contextReads = 0;

    mocks.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(slabKeypair.publicKey)) {
        return slabAccount;
      }

      if (pubkey.equals(lpPortfolioKeypair.publicKey)) {
        return makeAccount(portfolioData, programId);
      }

      if (pubkey.equals(matcherContextKeypair.publicKey)) {
        contextReads += 1;

        const matcherContextData = Buffer.alloc(actualSdk.MATCHER_CONTEXT_LEN);

        // First read: TX D has not landed.
        // Second read: final post-recovery verification.
        if (contextReads >= 2) {
          expectedDelegate.toBuffer().copy(matcherContextData, actualSdk.CTX_VAMM_OFFSET);
        }

        return makeAccount(matcherContextData, matcherProgramId);
      }

      return null;
    });

    mocks.sendTx.mockResolvedValue('matcher-context-initialized');

    const { result } = renderHook(() => useCreateMarket());

    act(() => {
      result.current.restoreSlabKeypair(slabKeypair, slabKeypair.publicKey.toBase58());
    });

    await act(async () => {
      await result.current.create(createParams(mint), 2);
    });

    expect(mocks.sendTx).toHaveBeenCalledTimes(1);

    const request = mocks.sendTx.mock.calls[0]?.[0] as {
      instructions: Array<{
        data: Uint8Array;
      }>;
      signers?: Keypair[];
    };

    expect(request.instructions).toHaveLength(1);
    expect(request.instructions[0]?.data[0]).toBe(83);
    expect(request.signers).toBeUndefined();

    expect(contextReads).toBe(2);

    expect(mocks.updateInFlightStep).toHaveBeenCalledWith(slabKeypair.publicKey.toBase58(), 3);
  });
});
