/**
 * useStakeDeposit Hook Tests
 *
 * useStakeDeposit is a thin wrapper around useStakeDepositByPool: it derives
 * slabAddress (route params) + collateralMint (SlabProvider) and delegates
 * everything else. The PDA derivation / ATA handling / tx-building logic
 * itself is exercised by useStakeDepositByPool.test.ts — this file only
 * verifies the wrapper derives the right params and passes through the
 * delegate's return value untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { PublicKey, Keypair } from '@solana/web3.js';

const useStakeDepositByPoolMock = vi.fn();

vi.mock('@/components/providers/SlabProvider', () => ({
  useSlabState: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: vi.fn(),
}));

vi.mock('@/hooks/useStakeDepositByPool', () => ({
  useStakeDepositByPool: (params: unknown) => useStakeDepositByPoolMock(params),
}));

import { useStakeDeposit } from '../../hooks/useStakeDeposit';
import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';

const mockSlabAddress = Keypair.generate().publicKey.toBase58();
const mockCollateralMint = new PublicKey('So11111111111111111111111111111111111111112');

describe('useStakeDeposit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStakeDepositByPoolMock.mockReturnValue({
      deposit: vi.fn().mockResolvedValue('fakeSig123'),
      loading: false,
      error: null,
    });
  });

  it('derives slabAddress from route params and collateralMint from SlabProvider', () => {
    vi.mocked(useParams).mockReturnValue({ slab: mockSlabAddress });
    vi.mocked(useSlabState).mockReturnValue({
      config: { collateralMint: mockCollateralMint, vaultPubkey: Keypair.generate().publicKey },
      programId: new PublicKey('5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf'),
    });

    renderHook(() => useStakeDeposit());

    expect(useStakeDepositByPoolMock).toHaveBeenCalledWith({
      slabAddress: mockSlabAddress,
      collateralMint: mockCollateralMint.toBase58(),
    });
  });

  it('falls back to empty strings when route params or market config are missing', () => {
    vi.mocked(useParams).mockReturnValue({});
    vi.mocked(useSlabState).mockReturnValue({ config: null, programId: null });

    renderHook(() => useStakeDeposit());

    expect(useStakeDepositByPoolMock).toHaveBeenCalledWith({
      slabAddress: '',
      collateralMint: '',
    });
  });

  it('passes through the delegate deposit/loading/error unchanged', async () => {
    vi.mocked(useParams).mockReturnValue({ slab: mockSlabAddress });
    vi.mocked(useSlabState).mockReturnValue({
      config: { collateralMint: mockCollateralMint, vaultPubkey: Keypair.generate().publicKey },
      programId: new PublicKey('5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf'),
    });
    const deposit = vi.fn().mockResolvedValue('fakeSig123');
    useStakeDepositByPoolMock.mockReturnValue({ deposit, loading: true, error: 'boom' });

    const { result } = renderHook(() => useStakeDeposit());

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe('boom');
    await expect(result.current.deposit(1_000_000n)).resolves.toBe('fakeSig123');
    expect(deposit).toHaveBeenCalledWith(1_000_000n);
  });
});
