/**
 * useStakeWithdraw Hook Tests
 *
 * useStakeWithdraw is a thin wrapper around useStakeWithdrawByPool: it
 * derives slabAddress (route params) + collateralMint (SlabProvider) and
 * delegates everything else. The PDA derivation / ATA handling / tx-building
 * logic itself is exercised by useStakeWithdrawByPool.test.ts — this file
 * only verifies the wrapper derives the right params and passes through the
 * delegate's return value untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { PublicKey, Keypair } from '@solana/web3.js';

const useStakeWithdrawByPoolMock = vi.fn();

vi.mock('@/components/providers/SlabProvider', () => ({
  useSlabState: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: vi.fn(),
}));

vi.mock('@/hooks/useStakeWithdrawByPool', () => ({
  useStakeWithdrawByPool: (params: unknown) => useStakeWithdrawByPoolMock(params),
}));

import { useStakeWithdraw } from '../../hooks/useStakeWithdraw';
import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';

const mockSlabAddress = Keypair.generate().publicKey.toBase58();
const mockCollateralMint = new PublicKey('So11111111111111111111111111111111111111112');

describe('useStakeWithdraw', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStakeWithdrawByPoolMock.mockReturnValue({
      withdraw: vi.fn().mockResolvedValue('withdrawSig456'),
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

    renderHook(() => useStakeWithdraw());

    expect(useStakeWithdrawByPoolMock).toHaveBeenCalledWith({
      slabAddress: mockSlabAddress,
      collateralMint: mockCollateralMint.toBase58(),
    });
  });

  it('falls back to empty strings when route params or market config are missing', () => {
    vi.mocked(useParams).mockReturnValue({});
    vi.mocked(useSlabState).mockReturnValue({ config: null, programId: null });

    renderHook(() => useStakeWithdraw());

    expect(useStakeWithdrawByPoolMock).toHaveBeenCalledWith({
      slabAddress: '',
      collateralMint: '',
    });
  });

  it('passes through the delegate withdraw/loading/error unchanged', async () => {
    vi.mocked(useParams).mockReturnValue({ slab: mockSlabAddress });
    vi.mocked(useSlabState).mockReturnValue({
      config: { collateralMint: mockCollateralMint, vaultPubkey: Keypair.generate().publicKey },
      programId: new PublicKey('5BZWY6XWPxuWFxs2nPCLLsVaKRWZVnzZh3FkJDLJBkJf'),
    });
    const withdraw = vi.fn().mockResolvedValue('withdrawSig456');
    useStakeWithdrawByPoolMock.mockReturnValue({ withdraw, loading: true, error: 'boom' });

    const { result } = renderHook(() => useStakeWithdraw());

    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe('boom');
    await expect(result.current.withdraw(500_000n)).resolves.toBe('withdrawSig456');
    expect(withdraw).toHaveBeenCalledWith(500_000n);
  });
});
