'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import { getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token';
import { STAKE_PROGRAM_ID, deriveDepositPda } from '@percolator/sdk';
import { getBackendUrl } from '@/lib/config';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** Shape returned by GET /api/stake/pools */
interface ApiPool {
  poolAddress: string;
  slabAddress: string;
  collateralMint: string;
  lpMint: string;
  vault: string;
  name: string;
  symbol: string;
  logoUrl: string | null;
  tvl: number;
  tvlRaw: string;
  totalLpSupply: number;
  cooldownSlots: number;
  apr: number;
  poolMode: number;
}

export interface LpPosition {
  /** Pool PDA address */
  poolAddress: string;
  /** Market slab address */
  slabAddress: string;
  /** Collateral mint (e.g. USDC) */
  collateralMint: string;
  /** LP mint for this pool */
  lpMint: string;
  /** Pool name (token/market symbol) */
  name: string;
  /** Token symbol (e.g. SOL) */
  symbol: string;
  /** Logo URL from Supabase */
  logoUrl: string | null;
  /** User's LP token balance in raw units */
  lpBalanceRaw: bigint;
  /** User's LP token balance as a formatted float */
  lpBalance: number;
  /** User's estimated redeemable value in collateral tokens (raw) */
  redeemableRaw: bigint;
  /** User's estimated redeemable value as float (USDC, 6 dec assumed) */
  redeemable: number;
  /** Pool-wide LP supply (raw) */
  totalLpSupply: number;
  /** Pool vault balance / TVL in USDC */
  tvl: number;
  /** User's share of the pool as a percent (0-100) */
  userSharePct: number;
  /** Cooldown in slots */
  cooldownSlots: number;
  /** Whether cooldown has elapsed for this user */
  cooldownElapsed: boolean;
  /** APR (0 until fee history indexed) */
  apr: number;
  /** Pool mode: 0 = insurance LP, 1 = trading LP */
  poolMode: number;
}

export interface LpPositionsState {
  positions: LpPosition[];
  totalRedeemable: number;
  loading: boolean;
  error: string | null;
}

// ═══════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════

/**
 * Fetches all stake pools, then for each pool queries the connected wallet's
 * LP token balance. Returns only pools where the user has a non-zero balance.
 *
 * Refreshes every 30 seconds. Call `refresh()` to force a refresh.
 */
export function useLpPositions(): LpPositionsState & { refresh: () => void } {
  const { connection } = useConnectionCompat();
  const wallet = useWalletCompat();

  const [positions, setPositions] = useState<LpPosition[]>([]);
  const [totalRedeemable, setTotalRedeemable] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const walletKeyStr = wallet.publicKey?.toBase58() ?? null;

  const fetchPositions = useCallback(async () => {
    if (!walletKeyStr || !connection) {
      setPositions([]);
      setTotalRedeemable(0);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 1. Fetch all pools
      const base = getBackendUrl();
      const res = await fetch(`${base}/api/stake/pools`);
      if (!res.ok) throw new Error(`Failed to fetch pools: ${res.status}`);
      const { pools } = (await res.json()) as { pools: ApiPool[] };

      if (!pools?.length) {
        setPositions([]);
        setTotalRedeemable(0);
        return;
      }

      const walletPk = new PublicKey(walletKeyStr);
      // STAKE_PROGRAM_ID is already a PublicKey instance from @percolator/sdk
      const stakeProgramPk = STAKE_PROGRAM_ID;

      // 2. For each pool, fetch user's LP token ATA and deposit PDA in parallel
      const slotNow = await connection.getSlot();

      const positionResults = await Promise.allSettled(
        pools.map(async (pool): Promise<LpPosition | null> => {
          const lpMintPk = new PublicKey(pool.lpMint);

          // Compute user's LP ATA
          let userLpAta: PublicKey;
          try {
            userLpAta = getAssociatedTokenAddressSync(lpMintPk, walletPk);
          } catch {
            return null;
          }

          // Fetch ATA account
          const ataInfo = await connection.getAccountInfo(userLpAta);
          if (!ataInfo || ataInfo.data.length < 165) return null;

          let lpBalanceRaw: bigint;
          try {
            const ata = unpackAccount(userLpAta, ataInfo);
            lpBalanceRaw = ata.amount;
          } catch {
            return null;
          }

          // Skip pools where user has no LP tokens
          if (lpBalanceRaw === 0n) return null;

          // 3. Compute redeemable value: (lpBalance / totalLpSupply) * tvl
          const DECIMALS = 6; // USDC 6 decimals
          const lpBalance = Number(lpBalanceRaw) / Math.pow(10, DECIMALS);
          const totalLpSupply = pool.totalLpSupply;
          const tvlRaw = BigInt(pool.tvlRaw);

          const redeemableRaw: bigint = totalLpSupply > 0
            ? (lpBalanceRaw * tvlRaw) / BigInt(Math.round(totalLpSupply))
            : 0n;
          const redeemable = Number(redeemableRaw) / Math.pow(10, DECIMALS);
          const userSharePct = totalLpSupply > 0
            ? (Number(lpBalanceRaw) / totalLpSupply) * 100
            : 0;

          // 4. Check cooldown status from deposit PDA
          // deriveDepositPda(pool PDA, user) — note: pool PDA, not slab
          let cooldownElapsed = true;
          try {
            const poolPk = new PublicKey(pool.poolAddress);
            const [depositPda] = deriveDepositPda(poolPk, walletPk, stakeProgramPk);
            const depositInfo = await connection.getAccountInfo(depositPda);
            if (depositInfo && depositInfo.data.length >= 80) {
              // StakeDeposit layout (percolator-stake/src/state.rs, #[repr(C)] Pod):
              //   is_initialized: u8 (1) + bump: u8 (1) + _padding: [u8;6] (6)
              //   pool: [u8;32] (32) + user: [u8;32] (32) → last_deposit_slot: u64 at offset 72
              //   lp_amount: u64 at offset 80 → total minimum size = 80 bytes
              const depositSlot = depositInfo.data.readBigUInt64LE(72);
              const cooldownSlots = BigInt(pool.cooldownSlots);
              cooldownElapsed = depositSlot === 0n || cooldownSlots === 0n
                || BigInt(slotNow) >= depositSlot + cooldownSlots;
            }
          } catch {
            // If PDA fetch fails, assume cooldown elapsed (safe default: let withdraw attempt fail on-chain)
            cooldownElapsed = true;
          }

          return {
            poolAddress: pool.poolAddress,
            slabAddress: pool.slabAddress,
            collateralMint: pool.collateralMint,
            lpMint: pool.lpMint,
            name: pool.name,
            symbol: pool.symbol,
            logoUrl: pool.logoUrl,
            lpBalanceRaw,
            lpBalance,
            redeemableRaw,
            redeemable,
            totalLpSupply: pool.totalLpSupply,
            tvl: pool.tvl,
            userSharePct,
            cooldownSlots: pool.cooldownSlots,
            cooldownElapsed,
            apr: pool.apr,
            poolMode: pool.poolMode,
          };
        })
      );

      const resolved: LpPosition[] = positionResults
        .filter((r): r is PromiseFulfilledResult<LpPosition | null> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((p): p is LpPosition => p !== null);

      const total = resolved.reduce((s, p) => s + p.redeemable, 0);
      setPositions(resolved);
      setTotalRedeemable(total);
    } catch (err: any) {
      console.error('[useLpPositions]', err);
      setError(err.message ?? 'Failed to load LP positions');
    } finally {
      setLoading(false);
    }
  }, [walletKeyStr, connection]);

  // Interval ref to avoid stale closures
  const fetchRef = useRef(fetchPositions);
  useEffect(() => { fetchRef.current = fetchPositions; }, [fetchPositions]);

  useEffect(() => {
    fetchRef.current();
    const interval = setInterval(() => fetchRef.current(), 30_000);
    return () => clearInterval(interval);
  }, [walletKeyStr]); // Re-subscribe when wallet changes

  return { positions, totalRedeemable, loading, error, refresh: fetchPositions };
}
