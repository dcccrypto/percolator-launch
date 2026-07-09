'use client';

import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';
import { useStakeWithdrawByPool } from './useStakeWithdrawByPool';

/**
 * Hook for withdrawing collateral from a percolator-stake pool from a
 * per-market route (`/trade/[slab]`) — derives slabAddress/collateralMint
 * from route params + SlabProvider context.
 *
 * Thin wrapper around `useStakeWithdrawByPool`, which holds the actual PDA
 * derivation, ATA handling, and tx-building logic. Kept as a separate hook
 * (rather than callers reaching for useStakeWithdrawByPool directly) purely
 * so route-context wiring lives in one place instead of being duplicated at
 * every call site.
 *
 * Burns LP tokens and returns the pro-rata share of collateral from the
 * vault. Subject to cooldown — will fail on-chain if cooldown hasn't
 * elapsed.
 *
 * Usage:
 * ```tsx
 * const { withdraw, loading, error } = useStakeWithdraw();
 * await withdraw(500_000n); // burn 0.5 LP tokens
 * ```
 */
export function useStakeWithdraw() {
  const slabState = useSlabState();
  const params = useParams();
  const slabAddress = params?.slab as string | undefined;
  const collateralMint = slabState.config?.collateralMint?.toBase58();

  return useStakeWithdrawByPool({
    slabAddress: slabAddress ?? '',
    collateralMint: collateralMint ?? '',
  });
}
