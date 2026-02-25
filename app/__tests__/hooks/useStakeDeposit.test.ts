/**
 * useStakeDeposit Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PublicKey, Keypair } from '@solana/web3.js';

// ── Hoisted values (available inside vi.mock factories) ────────
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

vi.mock('@/components/providers/SlabProvider', () => ({
  useSlabState: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: vi.fn(),
}));

vi.mock('@/lib/tx', () => ({
  sendTx: vi.fn(),
}));

vi.mock('@percolator/sdk', () => {
  const { PublicKey: PK } = require('@solana/web3.js');
  return {
    STAKE_PROGRAM_ID: new PK('4mJ8CasWfJCGEjGNaJThNfFfUWJTfZLBwz6qmUGqxVMc'),
    deriveStakePool: vi.fn().mockReturnValue([mockPool, 255]),
    deriveStakeVaultAuth: vi.fn().mockReturnValue([mockVaultAuth, 254]),
    deriveDepositPda: vi.fn().mockReturnValue([mockDepositPda, 253]),
    encodeStakeDeposit: vi.fn().mockReturnValue(Buffer.concat([Buffer.from([1]), Buffer.alloc(8)])),
    depositAccounts: vi.fn().mockReturnValue([
      { pubkey: new PK('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), isSigner: true, isWritable: false },
    ]),
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

import { useStakeDeposit } from '../../hooks/useStakeDeposit';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';
import { sendTx } from '@/lib/tx';
import { encodeStakeDeposit, depositAccounts } from '@percolator/sdk';

// Build a fake pool account buffer (186 bytes)
function buildPoolAccountData(): Buffer {
  const buf = Buffer.alloc(186);
  buf[0] = 1; // is_initialized
  mockLpMint.toBuffer().copy(buf, 65);
  mockVault.toBuffer().copy(buf, 97);
  return buf;
}

const mockWalletPubkey = new PublicKey('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
const mockSlabAddress = Keypair.generate().publicKey.toBase58();
const mockCollateralMint = new PublicKey('So11111111111111111111111111111111111111112');

describe('useStakeDeposit', () => {
  let mockConnection: any;
  let mockWallet: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConnection = {
      getAccountInfo: vi.fn().mockImplementation(async (pubkey: PublicKey) => {
        if (pubkey.equals(mockPool)) {
          return { data: buildPoolAccountData(), owner: new PublicKey('4mJ8CasWfJCGEjGNaJThNfFfUWJTfZLBwz6qmUGqxVMc') };
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

    (useConnectionCompat as any).mockReturnValue({ connection: mockConnection });
    (useWalletCompat as any).mockReturnValue(mockWallet);
    (useSlabState as any).mockReturnValue({
      config: { collateralMint: mockCollateralMint, vaultPubkey: mockVault },
      programId: new PublicKey('5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf'),
    });
    (useParams as any).mockReturnValue({ slab: mockSlabAddress });
    (sendTx as any).mockResolvedValue('fakeSig123');
  });

  it('successfully deposits and returns tx signature', async () => {
    const { result } = renderHook(() => useStakeDeposit());

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
    (useWalletCompat as any).mockReturnValue({
      publicKey: null,
      connected: false,
      signTransaction: undefined,
      disconnect: vi.fn(),
    });

    const { result } = renderHook(() => useStakeDeposit());

    await act(async () => {
      await expect(result.current.deposit(1_000_000n)).rejects.toThrow('Wallet not connected');
    });
    expect(result.current.error).toBe('Wallet not connected');
  });

  it('rejects when market not loaded', async () => {
    (useSlabState as any).mockReturnValue({ config: null, programId: null });

    const { result } = renderHook(() => useStakeDeposit());

    await act(async () => {
      await expect(result.current.deposit(1_000_000n)).rejects.toThrow('Market not loaded');
    });
  });

  it('rejects zero amount', async () => {
    const { result } = renderHook(() => useStakeDeposit());

    await act(async () => {
      await expect(result.current.deposit(0n)).rejects.toThrow('greater than zero');
    });
  });

  it('rejects when stake pool not initialized', async () => {
    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockPool)) return null;
      return { data: Buffer.alloc(165), owner: PublicKey.default };
    });

    const { result } = renderHook(() => useStakeDeposit());

    await act(async () => {
      await expect(result.current.deposit(1_000_000n)).rejects.toThrow('Stake pool not initialized');
    });
  });

  it('creates LP ATA when it does not exist', async () => {
    const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');

    let callIdx = 0;
    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockPool)) {
        return { data: buildPoolAccountData(), owner: new PublicKey('4mJ8CasWfJCGEjGNaJThNfFfUWJTfZLBwz6qmUGqxVMc') };
      }
      callIdx++;
      if (callIdx >= 3) return null; // LP ATA doesn't exist
      return { data: Buffer.alloc(165), owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
    });

    const { result } = renderHook(() => useStakeDeposit());

    await act(async () => {
      await result.current.deposit(1_000_000n);
    });

    expect(createAssociatedTokenAccountInstruction).toHaveBeenCalled();
  });

  it('sets loading state correctly during deposit', async () => {
    const { result } = renderHook(() => useStakeDeposit());
    expect(result.current.loading).toBe(false);

    await act(async () => {
      await result.current.deposit(1_000_000n);
    });

    expect(result.current.loading).toBe(false);
  });

  it('prevents double-submit', async () => {
    let resolveFirst!: (v: string) => void;
    (sendTx as any).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
    );

    const { result } = renderHook(() => useStakeDeposit());

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

    const { result } = renderHook(() => useStakeDeposit());

    await act(async () => {
      await expect(result.current.deposit(1_000_000n)).rejects.toThrow('Market not found');
    });
  });
});
