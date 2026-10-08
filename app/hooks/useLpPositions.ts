'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { bigintToFloat } from "@/lib/formatters";
import { PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import { useWalletCompat, useConnectionCompat } from '@/hooks/useWalletCompat';
import { getAssociatedTokenAddressSync, unpackAccount, unpackMint } from '@solana/spl-token';
import { deriveDepositPda } from '@percolatorct/sdk';
import { getConfig } from '@/lib/config';
import { pollWhenVisible } from '@/lib/pollWhenVisible';
import { getMultipleAccountsInfoChunked } from '@/lib/rpc-chunk';
import { readPoolTotalLpSupply, stakeValueAtoms } from '@/lib/stake-position';
import { readEarnPositions } from '@/lib/limits/earn-positions';
import { isBlockedSlab } from '@/lib/blocklist';
import { CURATED_COLLATERAL_DECIMALS } from '@/hooks/useEarnStats';


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
  /** null = not tracked (GET /api/stake/pools has no fee history). */
  apr: number | null;
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
  /**
   * "earn" = an Earn (LP vault) deposit: poolAddress is the market slab and only
   * lpBalanceRaw / redeemable are read; the pool-share, TVL and cooldown fields are 0.
   */
  kind: 'stake' | 'earn';
}

export interface LpPositionsState {
  positions: LpPosition[];
  totalRedeemable: number;
  loading: boolean;
  /** True only during background refreshes (not initial load) */
  isRefreshing: boolean;
  error: string | null;
}

/**
 * The wallet's Earn (LP vault) deposits. They live in the wrapper's LP Vault Registry, not in a
 * stake pool, so /api/stake/pools never lists them. Read over the markets /earn lists
 * (GET /api/markets) and valued like the Earn table (lib/limits/earn-positions.ts).
 */
async function readEarnRows(connection: Connection, wallet: PublicKey): Promise<LpPosition[]> {
  const res = await fetch('/api/markets?limit=500', { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch markets: ${res.status}`);
  const rows = ((await res.json()) as { markets?: unknown }).markets;
  if (!Array.isArray(rows)) throw new Error('Failed to fetch markets');
  const markets = rows.flatMap((m: Record<string, unknown>) => {
    const slab = typeof m?.slab_address === 'string' ? m.slab_address : null;
    if (!slab || isBlockedSlab(slab)) return [];
    const symbol = typeof m.symbol === 'string' && m.symbol ? m.symbol : slab.slice(0, 6);
    return [{ slab, symbol, name: typeof m.name === 'string' && m.name ? m.name : symbol }];
  });
  if (markets.length === 0) return [];
  const programId = new PublicKey(getConfig().programId as string);
  const held = await readEarnPositions(connection, programId, wallet, markets.map((m) => m.slab));
  return markets.flatMap((m) => {
    const p = held.get(m.slab);
    if (!p || p.shares === 0n || p.valueAtoms === null) return [];
    return [{
      poolAddress: m.slab,
      slabAddress: m.slab,
      collateralMint: '',
      lpMint: '',
      name: m.name,
      symbol: m.symbol,
      logoUrl: null,
      lpBalanceRaw: p.shares,
      lpBalance: 0,
      redeemableRaw: p.valueAtoms,
      redeemable: bigintToFloat(p.valueAtoms, CURATED_COLLATERAL_DECIMALS) ?? 0,
      totalLpSupply: 0,
      tvl: 0,
      userSharePct: 0,
      cooldownSlots: 0,
      cooldownElapsed: true,
      apr: 0,
      poolMode: 1,
      kind: 'earn' as const,
    }];
  });
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

    const walletPk = new PublicKey(walletKeyStr);
    // Read alongside the stake pools; a failure lands in the catch below via the awaits.
    const earnRows = readEarnRows(connection, walletPk);
    earnRows.catch(() => {});

    try {
      // 1. Fetch all pools (Next.js API route – use relative URL for same-origin)
      const res = await fetch(`/api/stake/pools`);
      if (!res.ok) throw new Error(`Failed to fetch pools: ${res.status}`);
      const { pools } = (await res.json()) as { pools: ApiPool[] };
      if (stale()) return;

      if (!pools?.length) {
        const earn = await earnRows;
        if (stale()) return;
        setPositions(earn);
        setTotalRedeemable(earn.reduce((s, p) => s + p.redeemable, 0));
        return;
      }

      // Stake pools are owned by this deployment's vault program
      // (getConfig().vaultProgramId), NOT the SDK's default stake program id.
      const stakeProgramPk = new PublicKey(
        (getConfig() as { vaultProgramId?: string }).vaultProgramId
        ?? DEVNET_PROGRAM_IDS.stake
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
      // Fresh pool + vault reads for the valuation (lib/stake-position.ts): the cached
      // /api/stake/pools snapshot predates a first deposit and valued the stake at 0.
      const poolBatchKeys = pools.map((p) => { try { return new PublicKey(p.poolAddress); } catch { return SystemProgram.programId; } });
      const vaultAcctKeys = pools.map((p) => { try { return new PublicKey(p.vault); } catch { return SystemProgram.programId; } });
      const ataBatchKeys = userLpAtas.map((k) => k ?? SystemProgram.programId);
      const depositBatchKeys = depositPdas.map((k) => k ?? SystemProgram.programId);

      // G: at 51+ stake pools, 2×pools.length (ATA + deposit-PDA) keys alone
      // exceeds the 100-key getMultipleAccountsInfo cap, which used to throw
      // and blank LP positions for every user — see lib/rpc-chunk.ts.
      const [lpMintInfos, collateralMintInfos, combinedAccountInfos, slotNow] = await Promise.all([
        getMultipleAccountsInfoChunked(connection, lpMintKeys),
        getMultipleAccountsInfoChunked(connection, collateralMintKeys),
        getMultipleAccountsInfoChunked(connection, [...ataBatchKeys, ...depositBatchKeys, ...poolBatchKeys, ...vaultAcctKeys]),
        connection.getSlot(),
      ]);
      if (stale()) return;
      const ataInfos = combinedAccountInfos.slice(0, pools.length);
      const depositInfos = combinedAccountInfos.slice(pools.length, 2 * pools.length);
      const poolInfos = combinedAccountInfos.slice(2 * pools.length, 3 * pools.length);
      const vaultInfos = combinedAccountInfos.slice(3 * pools.length);

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
        // #2324: null above MAX_SAFE_INTEGER rather than a wrong balance. 0 is a
        // deliberate fallback here — this feeds a list row, and a missing position
        // reads better than a confident wrong one.
        const lpBalance = bigintToFloat(lpBalanceRaw, lpMintDecimals) ?? 0;
        // Prefer FRESH on-chain pool supply + vault balance over the cached API snapshot.
        let totalLpSupply = pool.totalLpSupply;
        let tvlRaw = BigInt(pool.tvlRaw);
        try {
          const poolInfo = poolInfos[i];
          const vaultInfo = vaultInfos[i];
          const chainSupply = poolInfo ? readPoolTotalLpSupply(poolInfo.data) : null;
          if (chainSupply !== null && vaultInfo && vaultInfo.data.length >= 72) {
            totalLpSupply = Number(chainSupply);
            tvlRaw = new DataView(vaultInfo.data.buffer, vaultInfo.data.byteOffset, vaultInfo.data.byteLength).getBigUint64(64, true);
          }
        } catch {
          // keep the API snapshot
        }

        const redeemableRaw: bigint = totalLpSupply > 0
          ? stakeValueAtoms(lpBalanceRaw, BigInt(Math.round(totalLpSupply)), tvlRaw) ?? 0n
          : 0n;
        // Redeemable value is in the pool's collateral token — look up actual decimals.
        const collateralDecimals = collateralDecimalsByMint[pool.collateralMint] ?? 6;
        // #2324: same guard as the balance above.
        const redeemable = bigintToFloat(redeemableRaw, collateralDecimals) ?? 0;
        // `totalLpSupply` is a number here, so this is a bigint/number mix. Guard
        // the bigint side — the divisor cannot overflow, only the dividend can.
        const lpBalanceForPct = bigintToFloat(lpBalanceRaw, 0);
        const userSharePct =
          totalLpSupply > 0 && lpBalanceForPct !== null
            ? (lpBalanceForPct / totalLpSupply) * 100
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
          apr: pool.apr ?? 0, // 0 = no APR line on the card (LpPositionsPanel shows it only when > 0)
          poolMode: pool.poolMode,
          kind: 'stake',
        });
        return acc;
      }, []);

      resolved.push(...(await earnRows));
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
