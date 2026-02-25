/**
 * useStakePool Hook Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
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

vi.mock('@percolator/sdk', () => {
  const { PublicKey: PK } = require('@solana/web3.js');
  return {
    STAKE_PROGRAM_ID: new PK('4mJ8CasWfJCGEjGNaJThNfFfUWJTfZLBwz6qmUGqxVMc'),
    deriveStakePool: vi.fn().mockReturnValue([mockPool, 255]),
    deriveStakeVaultAuth: vi.fn().mockReturnValue([mockVaultAuth, 254]),
    deriveDepositPda: vi.fn().mockReturnValue([mockDepositPda, 253]),
  };
});

vi.mock('@solana/spl-token', () => {
  const { Keypair: Kp } = require('@solana/web3.js');
  return {
    getAssociatedTokenAddress: vi.fn().mockResolvedValue(Kp.generate().publicKey),
    unpackMint: vi.fn().mockReturnValue({ supply: 10_000_000n }),
    unpackAccount: vi.fn().mockReturnValue({ amount: 5_000_000n }),
  };
});

import { useStakePool } from '../../hooks/useStakePool';
import { useConnectionCompat, useWalletCompat } from '@/hooks/useWalletCompat';
import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';

const mockWalletPubkey = new PublicKey('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
const mockSlabAddress = Keypair.generate().publicKey.toBase58();
const mockCollateralMint = new PublicKey('So11111111111111111111111111111111111111112');

function buildPoolAccountData(opts?: {
  cooldownSlots?: bigint;
  depositCap?: bigint;
  totalDeposited?: bigint;
}): Buffer {
  const buf = Buffer.alloc(186);
  buf[0] = 1;
  mockLpMint.toBuffer().copy(buf, 65);
  mockVault.toBuffer().copy(buf, 97);
  mockVaultAuth.toBuffer().copy(buf, 129);
  buf[161] = 254;
  buf.writeBigUInt64LE(opts?.cooldownSlots ?? 0n, 162);
  buf.writeBigUInt64LE(opts?.depositCap ?? 0n, 170);
  buf.writeBigUInt64LE(opts?.totalDeposited ?? 0n, 178);
  return buf;
}

function buildDepositPdaData(opts?: { depositSlot?: bigint; amount?: bigint }): Buffer {
  const buf = Buffer.alloc(81);
  buf[0] = 1;
  mockPool.toBuffer().copy(buf, 1);
  mockWalletPubkey.toBuffer().copy(buf, 33);
  buf.writeBigUInt64LE(opts?.depositSlot ?? 100n, 65);
  buf.writeBigUInt64LE(opts?.amount ?? 1_000_000n, 73);
  return buf;
}

describe('useStakePool', () => {
  let mockConnection: any;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();

    mockConnection = {
      getAccountInfo: vi.fn().mockImplementation(async (pubkey: PublicKey) => {
        if (pubkey.equals(mockPool)) {
          return { data: buildPoolAccountData({ cooldownSlots: 100n }), owner: new PublicKey('4mJ8CasWfJCGEjGNaJThNfFfUWJTfZLBwz6qmUGqxVMc') };
        }
        if (pubkey.equals(mockDepositPda)) {
          return { data: buildDepositPdaData({ depositSlot: 50n }), owner: new PublicKey('4mJ8CasWfJCGEjGNaJThNfFfUWJTfZLBwz6qmUGqxVMc') };
        }
        return { data: Buffer.alloc(165), owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') };
      }),
      getSlot: vi.fn().mockResolvedValue(200),
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns default state when pool does not exist', async () => {
    mockConnection.getAccountInfo.mockImplementation(async (pubkey: PublicKey) => {
      if (pubkey.equals(mockPool)) return null;
      return { data: Buffer.alloc(165), owner: PublicKey.default };
    });

    const { result } = renderHook(() => useStakePool());

    await waitFor(() => {
      expect(result.current.state.poolExists).toBe(false);
    });

    expect(result.current.state.vaultBalance).toBe(0n);
    expect(result.current.state.lpSupply).toBe(0n);
  });

  it('parses pool and calculates redemption rate', async () => {
    const { result } = renderHook(() => useStakePool());

    await waitFor(() => {
      expect(result.current.state.poolExists).toBe(true);
    });

    // vault balance = 5_000_000 (unpackAccount), lp supply = 10_000_000 (unpackMint)
    // rate = (5M * 1M) / 10M = 500_000
    expect(result.current.state.vaultBalance).toBe(5_000_000n);
    expect(result.current.state.lpSupply).toBe(10_000_000n);
    expect(result.current.state.redemptionRateE6).toBe(500_000n);
  });

  it('calculates user share percentage', async () => {
    const { result } = renderHook(() => useStakePool());

    await waitFor(() => {
      expect(result.current.state.poolExists).toBe(true);
    });

    // user LP = 5M, total = 10M → 50%
    expect(result.current.state.userSharePct).toBe(50);
  });

  it('detects cooldown elapsed', async () => {
    // deposit_slot=50, cooldown=100, current_slot=200 → 200 >= 150 → elapsed
    const { result } = renderHook(() => useStakePool());

    await waitFor(() => {
      expect(result.current.state.poolExists).toBe(true);
    });

    expect(result.current.state.cooldownElapsed).toBe(true);
    expect(result.current.state.cooldownSlots).toBe(100n);
  });

  it('detects cooldown NOT elapsed', async () => {
    mockConnection.getSlot.mockResolvedValue(120); // 120 < 50+100=150

    const { result } = renderHook(() => useStakePool());

    await waitFor(() => {
      expect(result.current.state.poolExists).toBe(true);
    });

    expect(result.current.state.cooldownElapsed).toBe(false);
  });

  it('handles wallet not connected gracefully', async () => {
    (useWalletCompat as any).mockReturnValue({
      publicKey: null,
      connected: false,
      signTransaction: undefined,
      disconnect: vi.fn(),
    });

    const { result } = renderHook(() => useStakePool());

    await waitFor(() => {
      expect(result.current.state.poolExists).toBe(true);
    });

    expect(result.current.state.lpSupply).toBe(10_000_000n);
    expect(result.current.state.userLpBalance).toBe(0n);
    expect(result.current.state.userCollateralBalance).toBe(0n);
  });

  it('does not cause infinite re-render loop (H3 fix)', async () => {
    const { result } = renderHook(() => useStakePool());

    await waitFor(() => {
      expect(mockConnection.getAccountInfo).toHaveBeenCalled();
    });

    const callCountAfterInit = mockConnection.getAccountInfo.mock.calls.length;

    // 5 seconds — no refresh yet
    vi.advanceTimersByTime(5000);
    await waitFor(() => {});

    // 11 seconds total — one refresh
    vi.advanceTimersByTime(6000);
    await waitFor(() => {
      expect(mockConnection.getAccountInfo.mock.calls.length).toBeGreaterThan(callCountAfterInit);
    });
  });

  it('exposes PDA addresses', async () => {
    const { result } = renderHook(() => useStakePool());

    await waitFor(() => {
      expect(result.current.pdas).not.toBeNull();
    });

    expect(result.current.pdas?.poolPda.equals(mockPool)).toBe(true);
    expect(result.current.pdas?.vaultAuthPda.equals(mockVaultAuth)).toBe(true);
  });
});
