'use client';

import { useSlabState } from '@/components/providers/SlabProvider';
import { useParams } from 'next/navigation';
import { useStakeDepositByPool } from './useStakeDepositByPool';

/**
 * Hook for depositing collateral into a percolator-stake pool from a
 * per-market route (`/trade/[slab]`) — derives slabAddress/collateralMint
 * from route params + SlabProvider context.
 *
 * Thin wrapper around `useStakeDepositByPool`, which holds the actual PDA
 * derivation, ATA handling, and tx-building logic. Kept as a separate hook
 * (rather than callers reaching for useStakeDepositByPool directly) purely
 * so route-context wiring lives in one place instead of being duplicated at
 * every call site.
 *
 * Usage:
 * ```tsx
 * const { deposit, loading, error } = useStakeDeposit();
 * await deposit(1_000_000n); // deposit 1 USDC (6 decimals)
 * ```
 */
export function useStakeDeposit() {
  const slabState = useSlabState();
  const params = useParams();
  const slabAddress = params?.slab as string | undefined;
  const collateralMint = slabState.config?.collateralMint?.toBase58();

  return useStakeDepositByPool({
    slabAddress: slabAddress ?? '',
    collateralMint: collateralMint ?? '',
  });
}
