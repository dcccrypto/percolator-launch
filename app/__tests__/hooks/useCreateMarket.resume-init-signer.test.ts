/**
 * AUD-S1-30 (v2.2 audit 2026-10-17): a launch whose createAccount landed but whose InitMarket did not leaves an
 * uninitialised, program-owned slab. The step-0 resume re-sends InitMarket alone; it must be signed by the SLAB
 * keypair (meta isSigner + `signers: [slabKp]`), as the fresh createAccount + InitMarket transaction is, so the
 * program can require the market account's signature on InitMarket and nobody else can initialise (and later
 * close for its rent) a slab a failed launch left behind. Same harness as useCreateMarket.resume-slot-capacity.
 */
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
  connection: null as unknown as Record<string, unknown>,
  wallet: null as unknown as Record<string, unknown>,
  config: null as unknown as Record<string, unknown>,
  getAssociatedTokenAddress: vi.fn(),
}));

vi.mock('@/hooks/useWalletCompat', () => ({
  useConnectionCompat: () => ({ connection: mocks.connection }),
  useWalletCompat: () => mocks.wallet,
}));
vi.mock('@/lib/tx', () => ({ sendTx: mocks.sendTx }));
vi.mock('@/lib/config', () => ({ getConfig: () => mocks.config, getNetwork: () => 'mainnet' }));
vi.mock('@/lib/inFlightMarket', () => ({
  saveInFlightMarket: vi.fn(),
  updateInFlightStep: mocks.updateInFlightStep,
  clearInFlightMarket: vi.fn(),
  loadLastInFlightMarket: vi.fn(() => null),
}));
vi.mock('@solana/spl-token', async () => {
  const actual = await vi.importActual<typeof import('@solana/spl-token')>('@solana/spl-token');
  return { ...actual, getAccount: mocks.getAccount, getAssociatedTokenAddress: mocks.getAssociatedTokenAddress };
});
vi.mock('@percolatorct/sdk', async () => {
  const actual = await vi.importActual<typeof import('@percolatorct/sdk')>('@percolatorct/sdk');
  return { ...actual, deriveVaultAuthority: mocks.deriveVaultAuthority };
});

import { useCreateMarket } from '@/hooks/useCreateMarket';
import { slabSizeFor } from '@/lib/create-market-args';

const PROGRAM = new PublicKey('69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9');

describe('AUD-S1-30: the step-0 resume InitMarket is signed by the slab keypair', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.getMinimumBalanceForRentExemption.mockResolvedValue(1_000_000);
    mocks.getAssociatedTokenAddress.mockResolvedValue(new PublicKey(new Uint8Array(32).fill(24)));
    mocks.connection = {
      getAccountInfo: mocks.getAccountInfo,
      getProgramAccounts: mocks.getProgramAccounts,
      getMinimumBalanceForRentExemption: mocks.getMinimumBalanceForRentExemption,
    };
    const w = Keypair.generate();
    mocks.wallet = {
      publicKey: w.publicKey, connected: true, connecting: false,
      signTransaction: vi.fn(async (tx) => tx), signAllTransactions: vi.fn(async (txs) => txs), signMessage: vi.fn(), disconnect: vi.fn(),
    };
    mocks.config = { programId: PROGRAM.toBase58(), matcherProgramId: '4seJWjv3R5qfXY8R5ntuPHWsoqcVvaxvfFSnU2AnGMhT', programsBySlabTier: undefined };
    mocks.deriveVaultAuthority.mockReturnValue([new PublicKey(new Uint8Array(32).fill(23)), 255]);
    mocks.getAccount.mockResolvedValue({ amount: 0n });
    mocks.getProgramAccounts.mockResolvedValue([]);
  });

  it('marks the slab meta as a signer and passes the slab keypair', async () => {
    const slabKp = Keypair.fromSeed(new Uint8Array(32).fill(51));
    const mint = Keypair.generate().publicKey;
    const params = {
      mint, initialPriceE6: 100_000_000n, lpCollateral: 1_000_000n, insuranceAmount: 100_000n, oracleFeed: '0'.repeat(64),
      invert: false, tradingFeeBps: 10, initialMarginBps: 1_500, maxAccounts: 4_096, decimals: 6, symbol: 'TEST', name: 'Test Market',
      oracleMode: 'admin' as const,
    };
    // Created (program-owned, the market's exact length) but never initialised: all zeros.
    const stuck = { data: Buffer.alloc(slabSizeFor(params)), executable: false, lamports: 1, owner: PROGRAM, rentEpoch: 0 };
    mocks.getAccountInfo.mockImplementation(async (pk: PublicKey) => (pk.equals(slabKp.publicKey) ? stuck : null));
    // The resume InitMarket lands; the next transaction is refused so the run stops there.
    mocks.sendTx.mockResolvedValueOnce('resume-init-market').mockRejectedValue(new Error('stop here'));

    const { result } = renderHook(() => useCreateMarket());
    act(() => {
      result.current.restoreSlabKeypair(slabKp, slabKp.publicKey.toBase58());
    });
    await act(async () => {
      await result.current.create(params, 0).catch(() => undefined);
    });

    expect(mocks.sendTx).toHaveBeenCalled();
    const req = mocks.sendTx.mock.calls[0]![0] as {
      instructions: Array<{ programId: PublicKey; data: Uint8Array; keys: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> }>;
      signers?: Keypair[];
    };
    const init = req.instructions.find((ix) => ix.programId.equals(PROGRAM) && ix.data[0] === 0);
    expect(init, 'the resume sends InitMarket (tag 0)').toBeDefined();
    // No createAccount in this transaction: the slab already exists.
    expect(req.instructions.some((ix) => ix.programId.equals(new PublicKey('11111111111111111111111111111111')) && ix.data[0] === 0 && ix.keys[1]?.pubkey.equals(slabKp.publicKey))).toBe(false);
    const slabMeta = init!.keys[1]!;
    expect(slabMeta.pubkey.equals(slabKp.publicKey)).toBe(true);
    expect(slabMeta.isSigner, 'AUD-S1-30: the slab signs its InitMarket').toBe(true);
    expect(slabMeta.isWritable).toBe(true);
    expect(req.signers?.some((k) => k.publicKey.equals(slabKp.publicKey)), 'the slab keypair is passed to sendTx').toBe(true);
  });
});
