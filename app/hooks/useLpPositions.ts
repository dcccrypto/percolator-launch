'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import { getAssociatedTokenAddressSync, unpackAccount, unpackMint } from '@solana/spl-token';
import { deriveDepositPda } from '@percolatorct/sdk';
import { getConfig } from '@/lib/config';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { getMultipleAccountsInfoChunked } from '@/lib/rpc-chunk';


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
  /** True only during background refreshes (not initial load) */
  isRefreshing: boolean;
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
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const hasLoadedOnce = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const walletKeyStr = wallet.publicKey?.toBase58() ?? null;

  // PERC-9204: requestId/generation guard — fetchPositions has multiple
  // sequential awaits (pools fetch, mint batch, ATA+deposit-PDA batch,
  // getSlot). Without this, switching wallets mid-fetch let the OLD wallet's
  // slower in-flight fetch resolve AFTER the new wallet's fetch and stomp its
  // state (setPositions/setTotalRedeemable/setError, and the finally's
  // setLoading(false)/hasLoadedOnce). Mirrors the `stale()` pattern in
  // useInsuranceLP's refreshState.
  const requestIdRef = useRef(0);

  const fetchPositions = useCallback(async () => {
    if (!walletKeyStr || !connection) {
      // Invalidate any in-flight fetch from a previous wallet — it must not
      // land after this "no wallet" reset.
      requestIdRef.current++;
      setPositions([]);
      setTotalRedeemable(0);
      setLoading(false);
      setIsRefreshing(false);
      hasLoadedOnce.current = false;
      return;
    }

    const requestId = ++requestIdRef.current;
    const stale = () => requestId !== requestIdRef.current;

    if (hasLoadedOnce.current) {
      setIsRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      // 1. Fetch all pools (Next.js API route – use relative URL for same-origin)
      const res = await fetch(`/api/stake/pools`);
      if (!res.ok) throw new Error(`Failed to fetch pools: ${res.status}`);
      const { pools } = (await res.json()) as { pools: ApiPool[] };
      if (stale()) return;

      if (!pools?.length) {
        if (stale()) return;
        setPositions([]);
        setTotalRedeemable(0);
        return;
      }

      const walletPk = new PublicKey(walletKeyStr);
      // Stake pools are owned by this deployment's vault program
      // (getConfig().vaultProgramId), NOT the SDK's default stake program id.
      const stakeProgramPk = new PublicKey(
        (getConfig() as { vaultProgramId?: string }).vaultProgramId
        ?? 'GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3'
      );

      // 2a. Batch-fetch LP + collateral mint accounts to read per-mint decimals (PERC-8197).
      // Neither LP nor collateral tokens are guaranteed to have 6 decimals — hardcoding
      // causes wrong display values for non-USDC collaterals (e.g. SOL=9, BONK=5).
      const lpMintKeys = pools.map((p) => new PublicKey(p.lpMint));
      const collateralMintStrs = Array.from(new Set(pools.map((p) => p.collateralMint)));
      const collateralMintKeys = collateralMintStrs.map((m) => new PublicKey(m));

      // 2b. Precompute each pool's user LP ATA + deposit PDA (pure, synchronous
      // derivations — no RPC involved) so both can be read in the SAME batched
      // getMultipleAccountsInfo call as the mint lookups below, instead of the
      // previous per-pool `getAccountInfo(ata)` + `getAccountInfo(depositPda)`
      // pair (up to 2×N individual RPC round-trips for N pools against a
      // rate-limited devnet RPC). A pool whose ATA/PDA derivation fails is
      // marked invalid and simply excluded from the batch — the placeholder
      // System Program key still occupies its slot so every array stays
      // index-aligned with `pools`.
      const userLpAtas: (PublicKey | null)[] = pools.map((p) => {
        try {
          return getAssociatedTokenAddressSync(new PublicKey(p.lpMint), walletPk);
        } catch {
          return null;
        }
      });
      const depositPdas: (PublicKey | null)[] = pools.map((p) => {
        try {
          const poolPk = new PublicKey(p.poolAddress);
          const [depositPda] = deriveDepositPda(poolPk, walletPk, stakeProgramPk);
          return depositPda;
        } catch {
          return null;
        }
      });
      const ataBatchKeys = userLpAtas.map((k) => k ?? SystemProgram.programId);
      const depositBatchKeys = depositPdas.map((k) => k ?? SystemProgram.programId);

      // G: at 51+ stake pools, 2×pools.length (ATA + deposit-PDA) keys alone
      // exceeds the 100-key getMultipleAccountsInfo cap, which used to throw
      // and blank LP positions for every user — see lib/rpc-chunk.ts.
      const [lpMintInfos, collateralMintInfos, combinedAccountInfos, slotNow] = await Promise.all([
        getMultipleAccountsInfoChunked(connection, lpMintKeys),
        getMultipleAccountsInfoChunked(connection, collateralMintKeys),
        getMultipleAccountsInfoChunked(connection, [...ataBatchKeys, ...depositBatchKeys]),
        connection.getSlot(),
      ]);
      if (stale()) return;
      const ataInfos = combinedAccountInfos.slice(0, pools.length);
      const depositInfos = combinedAccountInfos.slice(pools.length);

      const lpDecimalsByMint: Record<string, number> = {};
      for (let i = 0; i < pools.length; i++) {
        const mintInfo = lpMintInfos[i];
        if (mintInfo && mintInfo.data.length >= 82) {
          try {
            const mint = unpackMint(lpMintKeys[i], mintInfo);
            lpDecimalsByMint[pools[i].lpMint] = mint.decimals;
          } catch {
            lpDecimalsByMint[pools[i].lpMint] = 6; // safe fallback
          }
        } else {
          lpDecimalsByMint[pools[i].lpMint] = 6; // safe fallback
        }
      }
      const collateralDecimalsByMint: Record<string, number> = {};
      for (let i = 0; i < collateralMintStrs.length; i++) {
        const mintInfo = collateralMintInfos[i];
        if (mintInfo && mintInfo.data.length >= 82) {
          try {
            const mint = unpackMint(collateralMintKeys[i], mintInfo);
            collateralDecimalsByMint[collateralMintStrs[i]] = mint.decimals;
          } catch {
            collateralDecimalsByMint[collateralMintStrs[i]] = 6;
          }
        } else {
          collateralDecimalsByMint[collateralMintStrs[i]] = 6;
        }
      }

      // 3. Build each pool's position synchronously from the batched account
      // infos fetched above — no more per-pool awaits, so this is a plain
      // map/filter instead of Promise.allSettled.
      const resolved: LpPosition[] = pools.reduce<LpPosition[]>((acc, pool, i) => {
        if (!userLpAtas[i]) return acc; // ATA derivation failed for this pool

        const ataInfo = ataInfos[i];
        if (!ataInfo || ataInfo.data.length < 165) return acc;

        let lpBalanceRaw: bigint;
        try {
          const ata = unpackAccount(userLpAtas[i]!, ataInfo);
          lpBalanceRaw = ata.amount;
        } catch {
          return acc;
        }

        // Skip pools where user has no LP tokens
        if (lpBalanceRaw === 0n) return acc;

        // Compute redeemable value: (lpBalance / totalLpSupply) * tvl
        // Use per-mint decimals — do NOT hardcode 6 (PERC-8197).
        const lpMintDecimals = lpDecimalsByMint[pool.lpMint] ?? 6;
        const lpBalance = Number(lpBalanceRaw) / Math.pow(10, lpMintDecimals);
        const totalLpSupply = pool.totalLpSupply;
        const tvlRaw = BigInt(pool.tvlRaw);

        const redeemableRaw: bigint = totalLpSupply > 0
          ? (lpBalanceRaw * tvlRaw) / BigInt(Math.round(totalLpSupply))
          : 0n;
        // Redeemable value is in the pool's collateral token — look up actual decimals.
        const collateralDecimals = collateralDecimalsByMint[pool.collateralMint] ?? 6;
        const redeemable = Number(redeemableRaw) / Math.pow(10, collateralDecimals);
        const userSharePct = totalLpSupply > 0
          ? (Number(lpBalanceRaw) / totalLpSupply) * 100
          : 0;

        // Check cooldown status from the batched deposit PDA info.
        let cooldownElapsed = true;
        const depositInfo = depositPdas[i] ? depositInfos[i] : null;
        try {
          if (depositInfo && depositInfo.data.length >= 80) {
            // StakeDeposit layout (percolator-stake/src/state.rs, #[repr(C)] Pod):
            //   is_initialized: u8 (1) + bump: u8 (1) + _padding: [u8;6] (6)
            //   pool: [u8;32] (32) + user: [u8;32] (32) → last_deposit_slot: u64 at offset 72
            //   lp_amount: u64 at offset 80 → total minimum size = 80 bytes
            // Use DataView for browser-safe u64 read (Buffer.readBigUInt64LE is Node.js-only)
            const _dv72 = new DataView(depositInfo.data.buffer, depositInfo.data.byteOffset, depositInfo.data.byteLength);
            const depositSlot = _dv72.getBigUint64(72, /* littleEndian= */ true);
            const cooldownSlots = BigInt(pool.cooldownSlots);
            cooldownElapsed = depositSlot === 0n || cooldownSlots === 0n
              || BigInt(slotNow) >= depositSlot + cooldownSlots;
          }
        } catch {
          // If parsing fails, assume cooldown elapsed (safe default: let withdraw attempt fail on-chain)
          cooldownElapsed = true;
        }

        acc.push({
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
        });
        return acc;
      }, []);

      if (stale()) return;
      const total = resolved.reduce((s, p) => s + p.redeemable, 0);
      setPositions(resolved);
      setTotalRedeemable(total);
    } catch (err: any) {
      if (stale()) return;
      console.error('[useLpPositions]', err);
      setError(err.message ?? 'Failed to load LP positions');
    } finally {
      // Guarded: a stale (superseded) call's finally must not clobber the
      // loading/refresh flags a newer call (e.g. after a wallet switch) is
      // still managing.
      if (!stale()) {
        setLoading(false);
        setIsRefreshing(false);
        hasLoadedOnce.current = true;
      }
    }
  }, [walletKeyStr, connection]);

  // Interval ref to avoid stale closures
  const fetchRef = useRef(fetchPositions);
  useEffect(() => { fetchRef.current = fetchPositions; }, [fetchPositions]);

  useEffect(() => {
    // New wallet identity should start with initial-load semantics (CodeRabbit fix)
    hasLoadedOnce.current = false;
    setIsRefreshing(false);
    fetchRef.current();
    // Visibility-gated: a backgrounded tab shouldn't keep polling the
    // rate-limited devnet RPC every 30s for a dashboard nobody is looking at.
    // Fires immediately on tab re-focus (catch-up refresh).
    return pollWhenVisible(() => fetchRef.current(), 30_000);
  }, [walletKeyStr]); // Re-subscribe when wallet changes

  return { positions, totalRedeemable, loading, isRefreshing, error, refresh: fetchPositions };
}
