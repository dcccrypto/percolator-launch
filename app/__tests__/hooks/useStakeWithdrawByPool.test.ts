/**
 * useStakeWithdrawByPool Hook Tests
 *
 * Standalone withdraw hook for the /stake overview page (no SlabProvider dependency).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PublicKey, Keypair } from '@solana/web3.js';

// ── Hoisted values ────────────────────────────────────────────
const { mockPool, mockVaultAuth, mockDepositPda, mockLpMint, mockVault } = vi.hoisted(() => {
  const { Keypair: Kp } = require('@solana/web3.js');
  return {
    mockPool: Kp.generate().publicKey,
    mockVaultAuth: Kp.generate().publicKey,
    mockDepositPda: Kp.generate().publicKey,
    mockLpMint: Kp.generate().publicKey,
    mockVault: Kp.generate().publicKey,
  };
});

// ── Mocks ──────────────────────────────────────────────────────

vi.mock('@/hooks/useWalletCompat', () => ({
  useConnectionCompat: vi.fn(),
  useWalletCompat: vi.fn(),
}));

vi.mock('@/lib/tx', () => ({
  sendTx: vi.fn(),
}));

vi.mock('@percolator/sdk', () => {
  const { PublicKey: PK } = require('@solana/web3.js');
  return {
    STAKE_PROGRAM_ID: new PK('6aJb1F9CDCVWCNYFwj8aQsVb696YnW6J1FznteHq4Q6k'),
    STAKE_POOL_SIZE: 352,
    deriveStakePool: vi.fn().mockReturnValue([mockPool, 255]),
    deriveStakeVaultAuth: vi.fn().mockReturnValue([mockVaultAuth, 254]),
    deriveDepositPda: vi.fn().mockReturnValue([mockDepositPda, 253]),
    encodeStakeWithdraw: vi.fn().mockReturnValue(Buffer.concat([Buffer.from([2]), Buffer.alloc(8)])),
    withdrawAccounts: vi.fn().mockReturnValue([
      { pubkey: new PK('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), isSigner: true, isWritable: false },
    ]),
    decodeStakePool: vi.fn().mockReturnValue({ lpMint: mockLpMint, vault: mockVault }),
  };
});

vi.mock('@solana/spl-token', () => {
  const { Keypair: Kp } = require('@solana/web3.js');
  const fakeAta = Kp.generate().publicKey;
  const { PublicKey: PK } = require('@solana/web3.js');
  return {
    getAssociatedTokenAddress: vi.fn().mockResolvedValue(fakeAta),
    createAssociatedTokenAccountInstruction: vi.fn().mockReturnValue({
      programId: new PK('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      keys: [],
      data: Buffer.alloc(0),
    }),
  };
});

import { useStakeWithdrawByPool } from '../../hooks/useStakeWithdrawByPool';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { sendTx } from '@/lib/tx';
import { encodeStakeWithdraw, withdrawAccounts } from '@percolator/sdk';

// Build a fake pool account buffer (352 bytes — canonical StakePool size).
// lpMint at offset 104, vault at offset 136 per decodeStakePool layout.
// decodeStakePool is mocked, so exact content doesn't matter; size must be ≥ 352.
function buildPoolAccountData(): Buffer {
  const buf = Buffer.alloc(352);
  buf[0] = 1; // is_initialized
  mockLpMint.toBuffer().copy(buf, 104);
  mockVault.toBuffer().copy(buf, 136);
  return buf;
}

const mockWalletPubkey = new PublicKey('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
const mockSlabAddress = Keypair.generate().publicKey.toBase58();
const mockCollateralMint = 'So11111111111111111111111111111111111111112';

const DEFAULT_PARAMS = { slabAddress: mockSlabAddress, collateralMint: mockCollateralMint };

describe('useStakeWithdrawByPool', () => {
  let mockConnection: ReturnType<typeof vi.fn>;
  let mockWallet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConnection = {
      getAccountInfo: vi.fn().mockImplementation(async (pubkey: PublicKey) => {
        if (pubkey.equals(mockPool)) {
          return { data: buildPoolAccountData(), owner: new PublicKey('6aJb1F9CDCVWCNYFwj8aQsVb696YnW6J1FznteHq4Q6k') };
        }
        return { data: Buffer.alloc(165), owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
      }),
    };

    mockWallet = {
      publicKey: mockWalletPubkey,
      connected: true,
      connecting: false,
      wallet: null,
      signTransaction: vi.fn(),
      disconnect: vi.fn(),
    };

    (useConnectionCompat as ReturnType<typeof vi.fn>).mockReturnValue({ connection: mockConnection });
    (useWalletCompat as ReturnType<typeof vi.fn>).mockReturnValue(mockWallet);
    (sendTx as ReturnType<typeof vi.fn>).mockResolvedValue('fakeWithdrawSig');
  });

  it('successfully withdraws and returns tx signature', async () => {
    const { result } = renderHook(() => useStakeWithdrawByPool(DEFAULT_PARAMS));

    let sig: string | undefined;
    await act(async () => {
      sig = await result.current.withdraw(500_000n);
    });

    expect(sig).toBe('fakeWithdrawSig');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(encodeStakeWithdraw).toHaveBeenCalledWith(500_000n);
    expect(withdrawAccounts).toHaveBeenCalled();
    expect(sendTx).toHaveBeenCalled();
  });

  it('rejects when wallet not connected', async () => {
    (useWalletCompat as ReturnType<typeof vi.fn>).mockReturnValue({
      publicKey: null,
      connected: false,
      signTransaction: undefined,
      disconnect: vi.fn(),
    });

    const { result } = renderHook(() => useStakeWithdrawByPool(DEFAULT_PARAMS));

    await act(async () => {
      await expect(result.current.withdraw(500_000n)).rejects.toThrow('Wallet not connected');
    });
    expect(result.current.error).toBe('Wallet not connected');
  });

  it('rejects when slabAddress is empty', async () => {
    const { result } = renderHook(() =>
      useStakeWithdrawByPool({ slabAddress: '', collateralMint: mockCollateralMint }),
    );

    await act(async () => {
      await expect(result.current.withdraw(500_000n)).rejects.toThrow('Pool not selected');
    });
  });

  it('rejects zero LP amount', async () => {
    const { result } = renderHook(() => useStakeWithdrawByPool(DEFAULT_PARAMS));

    await act(async () => {
      await expect(result.current.withdraw(0n)).rejects.toThrow('greater than zero');
    });
  });

  it('rejects when stake pool not initialized', async () => {
    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockPool)) return null;
      return { data: Buffer.alloc(165), owner: PublicKey.default };
    });

    const { result } = renderHook(() => useStakeWithdrawByPool(DEFAULT_PARAMS));

    await act(async () => {
      await expect(result.current.withdraw(500_000n)).rejects.toThrow('Stake pool not initialized');
    });
  });

  it('creates collateral ATA if missing (user may have closed it)', async () => {
    const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');

    let callIdx = 0;
    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockPool)) {
        return { data: buildPoolAccountData(), owner: new PublicKey('6aJb1F9CDCVWCNYFwj8aQsVb696YnW6J1FznteHq4Q6k') };
      }
      callIdx++;
      if (callIdx >= 2) return null; // collateral ATA missing
      return { data: Buffer.alloc(165), owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
    });

    const { result } = renderHook(() => useStakeWithdrawByPool(DEFAULT_PARAMS));

    await act(async () => {
      await result.current.withdraw(500_000n);
    });

    expect(createAssociatedTokenAccountInstruction).toHaveBeenCalled();
  });

  it('prevents double-submit', async () => {
    let resolveFirst!: (v: string) => void;
    (sendTx as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
    );

    const { result } = renderHook(() => useStakeWithdrawByPool(DEFAULT_PARAMS));

    let firstPromise: Promise<string>;
    act(() => {
      firstPromise = result.current.withdraw(500_000n);
    });

    await act(async () => {
      await expect(result.current.withdraw(250_000n)).rejects.toThrow('already in progress');
    });

    await act(async () => {
      resolveFirst('sig1');
      await firstPromise!;
    });
  });

  it('does NOT depend on SlabProvider or useParams', () => {
    expect(() => renderHook(() => useStakeWithdrawByPool(DEFAULT_PARAMS))).not.toThrow();
  });
});
