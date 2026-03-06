/**
 * useStakeDepositByPool Hook Tests
 *
 * Standalone deposit hook for the /stake overview page (no SlabProvider dependency).
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
    encodeStakeDeposit: vi.fn().mockReturnValue(Buffer.concat([Buffer.from([1]), Buffer.alloc(8)])),
    depositAccounts: vi.fn().mockReturnValue([
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

import { useStakeDepositByPool } from '../../hooks/useStakeDepositByPool';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { sendTx } from '@/lib/tx';
import { encodeStakeDeposit, depositAccounts } from '@percolator/sdk';

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

describe('useStakeDepositByPool', () => {
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
    (sendTx as ReturnType<typeof vi.fn>).mockResolvedValue('fakeSig123');
  });

  it('successfully deposits and returns tx signature', async () => {
    const { result } = renderHook(() => useStakeDepositByPool(DEFAULT_PARAMS));

    let sig: string | undefined;
    await act(async () => {
      sig = await result.current.deposit(1_000_000n);
    });

    expect(sig).toBe('fakeSig123');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(encodeStakeDeposit).toHaveBeenCalledWith(1_000_000n);
    expect(depositAccounts).toHaveBeenCalled();
    expect(sendTx).toHaveBeenCalled();
  });

  it('rejects when wallet not connected', async () => {
    (useWalletCompat as ReturnType<typeof vi.fn>).mockReturnValue({
      publicKey: null,
      connected: false,
      signTransaction: undefined,
      disconnect: vi.fn(),
    });

    const { result } = renderHook(() => useStakeDepositByPool(DEFAULT_PARAMS));

    await act(async () => {
      await expect(result.current.deposit(1_000_000n)).rejects.toThrow('Wallet not connected');
    });
    expect(result.current.error).toBe('Wallet not connected');
  });

  it('rejects when slabAddress is empty', async () => {
    const { result } = renderHook(() =>
      useStakeDepositByPool({ slabAddress: '', collateralMint: mockCollateralMint }),
    );

    await act(async () => {
      await expect(result.current.deposit(1_000_000n)).rejects.toThrow('Pool not selected');
    });
  });

  it('rejects when collateralMint is empty', async () => {
    const { result } = renderHook(() =>
      useStakeDepositByPool({ slabAddress: mockSlabAddress, collateralMint: '' }),
    );

    await act(async () => {
      await expect(result.current.deposit(1_000_000n)).rejects.toThrow('Pool not selected');
    });
  });

  it('rejects zero amount', async () => {
    const { result } = renderHook(() => useStakeDepositByPool(DEFAULT_PARAMS));

    await act(async () => {
      await expect(result.current.deposit(0n)).rejects.toThrow('greater than zero');
    });
  });

  it('rejects when stake pool not initialized', async () => {
    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockPool)) return null;
      return { data: Buffer.alloc(165), owner: PublicKey.default };
    });

    const { result } = renderHook(() => useStakeDepositByPool(DEFAULT_PARAMS));

    await act(async () => {
      await expect(result.current.deposit(1_000_000n)).rejects.toThrow('Stake pool not initialized');
    });
  });

  it('creates LP ATA when it does not exist', async () => {
    const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');

    let callIdx = 0;
    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockPool)) {
        return { data: buildPoolAccountData(), owner: new PublicKey('6aJb1F9CDCVWCNYFwj8aQsVb696YnW6J1FznteHq4Q6k') };
      }
      callIdx++;
      if (callIdx >= 3) return null; // LP ATA doesn't exist
      return { data: Buffer.alloc(165), owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
    });

    const { result } = renderHook(() => useStakeDepositByPool(DEFAULT_PARAMS));

    await act(async () => {
      await result.current.deposit(1_000_000n);
    });

    expect(createAssociatedTokenAccountInstruction).toHaveBeenCalled();
  });

  it('prevents double-submit', async () => {
    let resolveFirst!: (v: string) => void;
    (sendTx as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
    );

    const { result } = renderHook(() => useStakeDepositByPool(DEFAULT_PARAMS));

    let firstPromise: Promise<string>;
    act(() => {
      firstPromise = result.current.deposit(1_000_000n);
    });

    await act(async () => {
      await expect(result.current.deposit(500_000n)).rejects.toThrow('already in progress');
    });

    await act(async () => {
      resolveFirst('sig1');
      await firstPromise!;
    });
  });

  it('handles network mismatch (P-CRITICAL-3)', async () => {
    let callIdx = 0;
    mockConnection.getAccountInfo.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1) return null; // slab not found
      return { data: buildPoolAccountData(), owner: PublicKey.default };
    });

    const { result } = renderHook(() => useStakeDepositByPool(DEFAULT_PARAMS));

    await act(async () => {
      await expect(result.current.deposit(1_000_000n)).rejects.toThrow('Market not found');
    });
  });

  it('does NOT depend on SlabProvider or useParams', () => {
    // This test simply verifies the hook can render without those providers.
    // If it throws "useSlabState must be used within a SlabProvider", the test fails.
    expect(() => renderHook(() => useStakeDepositByPool(DEFAULT_PARAMS))).not.toThrow();
  });
});
