/**
 * useStakeWithdraw Hook Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PublicKey, Keypair } from '@solana/web3.js';

// ── Hoisted values ─────────────────────────────────────────────
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
    encodeStakeWithdraw: vi.fn().mockReturnValue(Buffer.concat([Buffer.from([2]), Buffer.alloc(8)])),
    withdrawAccounts: vi.fn().mockReturnValue([
      { pubkey: new PK('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'), isSigner: true, isWritable: false },
    ]),
  };
});

vi.mock('@solana/spl-token', () => {
  const { Keypair: Kp, PublicKey: PK } = require('@solana/web3.js');
  return {
    getAssociatedTokenAddress: vi.fn().mockResolvedValue(Kp.generate().publicKey),
    createAssociatedTokenAccountInstruction: vi.fn().mockReturnValue({
      programId: new PK('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      keys: [],
      data: Buffer.alloc(0),
    }),
  };
});

import { useStakeWithdraw } from '../../hooks/useStakeWithdraw';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';
import { sendTx } from '@/lib/tx';
import { encodeStakeWithdraw, withdrawAccounts } from '@percolator/sdk';

function buildPoolAccountData(): Buffer {
  const buf = Buffer.alloc(186);
  buf[0] = 1;
  mockLpMint.toBuffer().copy(buf, 65);
  mockVault.toBuffer().copy(buf, 97);
  return buf;
}

const mockWalletPubkey = new PublicKey('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
const mockSlabAddress = Keypair.generate().publicKey.toBase58();
const mockCollateralMint = new PublicKey('So11111111111111111111111111111111111111112');

describe('useStakeWithdraw', () => {
  let mockConnection: any;

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

    (useConnectionCompat as any).mockReturnValue({ connection: mockConnection });
    (useWalletCompat as any).mockReturnValue({
      publicKey: mockWalletPubkey,
      connected: true,
      connecting: false,
      wallet: null,
      signTransaction: vi.fn(),
      disconnect: vi.fn(),
    });
    (useSlabState as any).mockReturnValue({
      config: { collateralMint: mockCollateralMint, vaultPubkey: mockVault },
      programId: new PublicKey('5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf'),
    });
    (useParams as any).mockReturnValue({ slab: mockSlabAddress });
    (sendTx as any).mockResolvedValue('withdrawSig456');
  });

  it('successfully withdraws and returns tx signature', async () => {
    const { result } = renderHook(() => useStakeWithdraw());

    let sig: string | undefined;
    await act(async () => {
      sig = await result.current.withdraw(500_000n);
    });

    expect(sig).toBe('withdrawSig456');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(encodeStakeWithdraw).toHaveBeenCalledWith(500_000n);
    expect(withdrawAccounts).toHaveBeenCalled();
    expect(sendTx).toHaveBeenCalled();
  });

  it('rejects when wallet not connected', async () => {
    (useWalletCompat as any).mockReturnValue({
      publicKey: null,
      connected: false,
      signTransaction: undefined,
      disconnect: vi.fn(),
    });

    const { result } = renderHook(() => useStakeWithdraw());

    await act(async () => {
      await expect(result.current.withdraw(500_000n)).rejects.toThrow('Wallet not connected');
    });
    expect(result.current.error).toBe('Wallet not connected');
  });

  it('rejects when market not loaded', async () => {
    (useSlabState as any).mockReturnValue({ config: null, programId: null });

    const { result } = renderHook(() => useStakeWithdraw());

    await act(async () => {
      await expect(result.current.withdraw(500_000n)).rejects.toThrow('Market not loaded');
    });
  });

  it('rejects zero amount', async () => {
    const { result } = renderHook(() => useStakeWithdraw());

    await act(async () => {
      await expect(result.current.withdraw(0n)).rejects.toThrow('greater than zero');
    });
  });

  it('rejects when stake pool not initialized', async () => {
    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockPool)) return null;
      return { data: Buffer.alloc(165), owner: PublicKey.default };
    });

    const { result } = renderHook(() => useStakeWithdraw());

    await act(async () => {
      await expect(result.current.withdraw(500_000n)).rejects.toThrow('Stake pool not initialized');
    });
  });

  it('creates collateral ATA when it does not exist', async () => {
    const { createAssociatedTokenAccountInstruction } = await import('@solana/spl-token');

    // Withdraw checks: 1) slab validation, 2) pool fetch, 3) collateral ATA check
    // We need the collateral ATA check (the last getAccountInfo call) to return null
    const calls: PublicKey[] = [];
    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      calls.push(pubkey);
      if (pubkey.equals(mockPool)) {
        return { data: buildPoolAccountData(), owner: new PublicKey('4mJ8CasWfJCGEjGNaJThNfFfUWJTfZLBwz6qmUGqxVMc') };
      }
      // First non-pool call is slab validation → return data
      // Second non-pool call is collateral ATA → return null
      const nonPoolCalls = calls.filter(p => !p.equals(mockPool)).length;
      if (nonPoolCalls >= 2) return null;
      return { data: Buffer.alloc(165), owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
    });

    const { result } = renderHook(() => useStakeWithdraw());

    await act(async () => {
      await result.current.withdraw(500_000n);
    });

    expect(createAssociatedTokenAccountInstruction).toHaveBeenCalled();
  });

  it('prevents double-submit', async () => {
    let resolveFirst!: (v: string) => void;
    (sendTx as any).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
    );

    const { result } = renderHook(() => useStakeWithdraw());

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

  it('encodes correct instruction tag (2 = Withdraw)', async () => {
    const { result } = renderHook(() => useStakeWithdraw());

    await act(async () => {
      await result.current.withdraw(999n);
    });

    expect(encodeStakeWithdraw).toHaveBeenCalledWith(999n);
  });
});
