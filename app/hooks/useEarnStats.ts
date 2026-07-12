'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { deriveLpVaultRegistry, parseLpVaultRegistry, isV17Account } from '@percolatorct/sdk';
import { getConfig, getRpcEndpoint } from '@/lib/config';
import { getSupabase } from '@/lib/supabase';
import { isMockMode } from '@/lib/mock-mode';
import { isBlockedSlab } from '@/lib/blocklist';
import { sanitizeOnChainValue } from '@/lib/health';
import { PLAYGROUND_SLAB_META } from '@/lib/playground-slab-meta';
import { parseV17RiskParams } from '@/lib/v17-engine-config';
import { pollWhenVisible } from '@/lib/pollWhenVisible';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface MarketVaultInfo {
  slabAddress: string;
  symbol: string;
  name: string;
  /** Mainnet contract address of the underlying token — resolves the card's real DEX logo. Null when unknown. */
  mainnetCa: string | null;
  /** Vault collateral balance (lamports) */
  vaultBalance: number;
  /** Total open interest (long + short, in USD) */
  totalOI: number;
  /** Max OI capacity (based on LP capital × max leverage) */
  maxOI: number;
  /** Insurance fund balance */
  insuranceFund: number;
  /** 24h volume in USD */
  volume24h: number;
  /** Trading fee bps */
  tradingFeeBps: number;
  /** Max leverage */
  maxLeverage: number;
  /** OI utilization percentage (totalOI / maxOI × 100) */
  oiUtilPct: number;
  /** Collateral token decimals */
  decimals: number;
}

export interface EarnStats {
  /** Total value locked across all vaults */
  tvl: number;
  /** Platform-wide total OI */
  totalOI: number;
  /** Platform-wide max OI capacity */
  maxOI: number;
  /** Platform-wide OI utilization */
  oiUtilPct: number;
  /** Insurance fund total */
  totalInsurance: number;
  /** Per-market vault breakdown */
  markets: MarketVaultInfo[];
  /** Total 24h fee revenue estimate (USD) */
  dailyFeeRevenue: number;
}

const DEFAULT_STATS: EarnStats = {
  tvl: 0,
  totalOI: 0,
  maxOI: 0,
  oiUtilPct: 0,
  totalInsurance: 0,
  markets: [],
  dailyFeeRevenue: 0,
};

/**
 * Module-level singleton RPC connection shared by fetchCuratedVaultsOnChain and
 * fetchOnChainMaxLeverage below. Both used to construct their own `new
 * Connection(...)` on every invocation — this hook's 15s auto-refresh interval
 * (see the effect at the bottom of the file) means that was a fresh Connection
 * object every 15s for the lifetime of the Earn page, for no benefit: the RPC
 * endpoint (`getRpcEndpoint()`) is a static config value for the life of the
 * session, so there's nothing per-call that requires a fresh instance.
 */
let sharedEarnStatsConnection: Connection | null = null;
function getSharedEarnStatsConnection(): Connection {
  if (!sharedEarnStatsConnection) {
    sharedEarnStatsConnection = new Connection(getRpcEndpoint(), 'confirmed');
  }
  return sharedEarnStatsConnection;
}

// ═══════════════════════════════════════════════════════════════
// Mock data for devnet / offline
// ═══════════════════════════════════════════════════════════════

function generateMockStats(): EarnStats {
  const markets: MarketVaultInfo[] = [
    {
      slabAddress: 'mock-sol-perp',
      symbol: 'SOL',
      name: 'Solana',
      mainnetCa: null,
      vaultBalance: 125_000_000_000, // 125 SOL
      totalOI: 45_200,
      maxOI: 250_000,
      insuranceFund: 12_000_000_000,
      volume24h: 128_450,
      tradingFeeBps: 10,
      maxLeverage: 20,
      oiUtilPct: 18.1, decimals: 9,
    },
    {
      slabAddress: 'mock-bonk-perp',
      symbol: 'BONK',
      name: 'Bonk',
      mainnetCa: null,
      vaultBalance: 85_000_000_000,
      totalOI: 22_100,
      maxOI: 170_000,
      insuranceFund: 5_000_000_000,
      volume24h: 89_200,
      tradingFeeBps: 15,
      maxLeverage: 10,
      oiUtilPct: 13.0, decimals: 6,
    },
    {
      slabAddress: 'mock-wif-perp',
      symbol: 'WIF',
      name: 'dogwifhat',
      mainnetCa: null,
      vaultBalance: 42_000_000_000,
      totalOI: 15_800,
      maxOI: 84_000,
      insuranceFund: 3_500_000_000,
      volume24h: 67_300,
      tradingFeeBps: 15,
      maxLeverage: 10,
      oiUtilPct: 18.8, decimals: 6,
    },
    {
      slabAddress: 'mock-jup-perp',
      symbol: 'JUP',
      name: 'Jupiter',
      mainnetCa: null,
      vaultBalance: 38_000_000_000,
      totalOI: 9_400,
      maxOI: 76_000,
      insuranceFund: 2_800_000_000,
      volume24h: 41_600,
      tradingFeeBps: 12,
      maxLeverage: 15,
      oiUtilPct: 12.4, decimals: 6,
    },
  ];

  const tvl = markets.reduce((s, m) => s + m.vaultBalance / (10 ** m.decimals), 0);
  const totalOI = markets.reduce((s, m) => s + m.totalOI, 0);
  const maxOI = markets.reduce((s, m) => s + m.maxOI, 0);
  const totalInsurance = markets.reduce((s, m) => s + m.insuranceFund / (10 ** m.decimals), 0);
  const dailyFeeRevenue = markets.reduce(
    (s, m) => s + (m.volume24h * m.tradingFeeBps) / 10_000,
    0,
  );

  return {
    tvl: tvl * 150, // Convert SOL to rough USD at $150
    totalOI,
    maxOI,
    oiUtilPct: maxOI > 0 ? (totalOI / maxOI) * 100 : 0,
    totalInsurance: totalInsurance * 150,
    markets,
    dailyFeeRevenue,
  };
}

// ═══════════════════════════════════════════════════════════════
// Curated playground markets — on-chain LP Vault Registry TVL
// ═══════════════════════════════════════════════════════════════

/** Sim-USDC collateral decimals — the single collateral token shared by every playground market. */
export const CURATED_COLLATERAL_DECIMALS = 6;

/** GH#1165 — sanity cap on any single vault's displayed TVL (USD). */
export const MAX_VAULT_USD = 10_000_000;

export interface CuratedVaultOnChain {
  /** Total atoms backing the LP vault (shares outstanding + distributed fee atoms). */
  tvlAtoms: bigint;
  /** Redemption cooldown period from the registry, in slots. */
  cooldownSlots: bigint;
  /** Whether an LP Vault Registry account was actually found on-chain for this slab. */
  found: boolean;
}

/** Minimal shape read from GET /api/playground/registered-markets for Earn-page seeding. */
interface RegisteredMarketMeta {
  slabAddress: string;
  symbol: string;
  name: string;
  mainnetCa: string | null;
}

/**
 * Fetch the playground's dynamically-registered (user-launched) markets from the
 * registration Blob endpoint, so their Earn vaults can be seeded alongside the 5
 * curated markets. Client-side fetch (this hook runs in the browser) — never throws;
 * on any failure returns [] and the Earn page simply shows the curated 5, same as
 * before user-launched markets could carry an Earn vault.
 */
async function fetchRegisteredMarketsMeta(): Promise<RegisteredMarketMeta[]> {
  try {
    const resp = await fetch('/api/playground/registered-markets', { cache: 'no-store' });
    if (!resp.ok) return [];
    const data: unknown = await resp.json();
    const markets = (data as { markets?: unknown })?.markets;
    if (!Array.isArray(markets)) return [];

    return markets.reduce<RegisteredMarketMeta[]>((acc, entry) => {
      if (typeof entry !== 'object' || entry === null) return acc;
      const m = entry as Record<string, unknown>;
      const slabAddress = typeof m.slabAddress === 'string' ? m.slabAddress : null;
      if (!slabAddress) return acc;
      const label = typeof m.label === 'string' && m.label ? m.label : null;
      const symbol = typeof m.symbol === 'string' && m.symbol ? m.symbol : (label ?? `${slabAddress.slice(0, 6)}-PERP`);
      const name = label ?? symbol;
      const mainnetCa = typeof m.mainnetCA === 'string' && m.mainnetCA ? m.mainnetCA : null;
      acc.push({ slabAddress, symbol, name, mainnetCa });
      return acc;
    }, []);
  } catch {
    return [];
  }
}

/**
 * Read the LP Vault Registry for each given slab directly on-chain (batched via
 * getMultipleAccountsInfo) and return each vault's real backing
 * (`totalLpSharesOutstanding + feeDistributionTotalAtoms`).
 *
 * This is the single source of truth for Earn-page TVL — NOT Supabase's
 * `markets_with_stats.vault_balance`, which mirrors the market's shared engine
 * vault (LP portfolio inventory + trader margin + LP-vault deposits all
 * commingled — verified on-chain 2026-07-07: SOL's shared vault held 91,000
 * Sim-USDC while its LP Vault Registry backed only the real ~10,000 deposit).
 *
 * `slabs` is the combined set of the 5 curated PLAYGROUND_SLAB_META markets plus
 * any registered (user-launched) markets, so launched markets' real Earn TVL is
 * read the same way as the curated ones.
 *
 * Never throws — on any failure (RPC hiccup, registry not yet created, SDK
 * mismatch) the affected slab(s) default to `{ tvlAtoms: 0n, cooldownSlots: 0n,
 * found: false }` rather than surfacing garbage.
 *
 * Returns `{ data, ok }` — `ok` is false ONLY when the whole batched RPC call
 * failed (e.g. transient devnet RPC hiccup), as distinct from a single slab
 * legitimately having no registry yet (that's a normal `found: false`, not an
 * error). `fetchStats` below uses `ok` to decide whether this cycle's result is
 * trustworthy enough to publish, or whether to keep showing the last good
 * snapshot (PERC-9204 — a single transient RPC failure on the 15s poll used to
 * blank the whole Earn page to $0 TVL / vanished markets until the next good
 * poll).
 */
async function fetchCuratedVaultsOnChain(
  slabs: string[],
): Promise<{ data: Record<string, CuratedVaultOnChain>; ok: boolean }> {
  const result: Record<string, CuratedVaultOnChain> = {};
  for (const slab of slabs) result[slab] = { tvlAtoms: 0n, cooldownSlots: 0n, found: false };
  if (slabs.length === 0) return { data: result, ok: true };

  try {
    const programId = new PublicKey(getConfig().programId);
    const connection = getSharedEarnStatsConnection();
    const registryPdas = slabs.map(
      (slab) => deriveLpVaultRegistry(programId, new PublicKey(slab))[0],
    );
    const infos = await connection.getMultipleAccountsInfo(registryPdas);

    slabs.forEach((slab, i) => {
      const info = infos[i];
      if (!info || info.data.length === 0) return;
      try {
        const registry = parseLpVaultRegistry(new Uint8Array(info.data));
        const shares = sanitizeOnChainValue(registry.totalLpSharesOutstanding);
        const feeAtoms = sanitizeOnChainValue(registry.feeDistributionTotalAtoms);
        result[slab] = {
          tvlAtoms: shares + feeAtoms,
          cooldownSlots: sanitizeOnChainValue(registry.redemptionCooldownSlots),
          found: true,
        };
      } catch {
        // Malformed/unrecognized account for this slab — leave the not-found default.
      }
    });
  } catch (err) {
    console.error('[useEarnStats] Failed to fetch LP vault registries on-chain:', err);
    return { data: result, ok: false };
  }

  return { data: result, ok: true };
}

/**
 * Bug fix (leverage display): per-market on-chain `initialMarginBps` varies
 * (e.g. re-seeded devnet SOL=667bps -> 14x, others=1000bps -> 10x). This used
 * to read ONLY `row?.max_leverage` (Supabase), which is blank on the local
 * playground (no Supabase configured) — every vault card silently fell back to
 * a hardcoded 10x, including SOL. Mirrors computeMaxLeverage() in
 * app/api/markets/route.ts.
 */
function computeMaxLeverageFromBps(bps: bigint | null | undefined): number {
  if (bps == null || bps <= 0n) return 10;
  const lev = Math.floor(10000 / Number(bps));
  return Number.isFinite(lev) && lev > 0 ? lev : 10;
}

/**
 * Read each slab's real per-market `initialMarginBps` directly on-chain (batched
 * via getMultipleAccountsInfo) and convert to a display max-leverage. This is the
 * accuracy-critical source for Max Leverage / Max OI — NOT Supabase's
 * `max_leverage` column, which is blank on the local playground.
 *
 * Never throws — on any failure (RPC hiccup, parse mismatch) the affected
 * slab(s) are simply absent from the result and callers fall back to the
 * Supabase/default value, same degrade-gracefully spirit as
 * fetchCuratedVaultsOnChain above.
 *
 * Returns `{ data, ok }` — same keep-last-good contract as
 * fetchCuratedVaultsOnChain: `ok` is false only when the batched RPC call
 * itself failed, not when an individual slab simply isn't a v17 account yet.
 */
async function fetchOnChainMaxLeverage(
  slabs: string[],
): Promise<{ data: Record<string, number>; ok: boolean }> {
  const result: Record<string, number> = {};
  if (slabs.length === 0) return { data: result, ok: true };

  try {
    const connection = getSharedEarnStatsConnection();
    const pks = slabs.map((s) => new PublicKey(s));
    const infos = await connection.getMultipleAccountsInfo(pks);

    infos.forEach((info, i) => {
      if (!info?.data) return;
      const data = new Uint8Array(info.data);
      if (!isV17Account(data)) return;
      // tradeFeeBps is unused for the leverage derivation (initialMarginBps
      // only) — 0n is a safe placeholder here, unlike the RiskParams consumers
      // elsewhere that also need the real trading fee.
      const params = parseV17RiskParams(data, 0n);
      if (params) result[slabs[i]] = computeMaxLeverageFromBps(params.initialMarginBps);
    });
  } catch (err) {
    console.error('[useEarnStats] Failed to fetch on-chain max leverage:', err);
    return { data: result, ok: false };
  }

  return { data: result, ok: true };
}

/**
 * Build a single market's MarketVaultInfo from its on-chain vault data + optional
 * Supabase cosmetic row. Shared by both the curated (PLAYGROUND_SLAB_META) markets
 * and the registered (user-launched) markets below.
 */
export function buildMarketVaultInfo(
  slab: string,
  symbol: string,
  name: string,
  mainnetCa: string | null,
  curatedVaults: Record<string, CuratedVaultOnChain>,
  supabaseBySlab: Map<string, Record<string, unknown>>,
  onChainMaxLeverage: Record<string, number> = {},
): MarketVaultInfo {
  const isSentinel = (v: number) => v > 1e18;
  const row = supabaseBySlab.get(slab);
  const decimals = CURATED_COLLATERAL_DECIMALS;
  const collDivisor = 10 ** decimals;

  const vaultAtoms = curatedVaults[slab]?.tvlAtoms ?? 0n;
  const vaultBalanceRaw = Number(vaultAtoms); // atoms — matches MarketVaultInfo.vaultBalance convention
  // GH#1165: a corrupt-but-sub-sentinel atom count (e.g. 4e14 at 6 decimals =
  // $400M) passes sanitizeOnChainValue's u64::MAX-class filter untouched. Cap
  // any single vault's displayed TVL at a sane ceiling rather than trust it blind.
  const vaultUsdUncapped = vaultBalanceRaw / collDivisor;
  const vaultBalance = vaultUsdUncapped > MAX_VAULT_USD ? 0 : vaultBalanceRaw;
  const vaultUsd = vaultBalance / collDivisor;

  const oiLongRaw = Number(row?.open_interest_long ?? 0);
  const oiShortRaw = Number(row?.open_interest_short ?? 0);
  const totalOIRaw = Number(row?.total_open_interest ?? oiLongRaw + oiShortRaw);
  const totalOI = isSentinel(totalOIRaw) ? 0 : totalOIRaw / collDivisor;

  // Real on-chain initialMarginBps first (accurate per-market cap); Supabase
  // max_leverage as secondary (populated on networks where the DB is live);
  // 10 only as the genuine last resort (both sources unavailable).
  const maxLeverage = onChainMaxLeverage[slab] ?? (Number(row?.max_leverage) || 10);
  const tradingFeeBpsRaw = Number(row?.trading_fee_bps ?? 10);
  const tradingFeeBps = tradingFeeBpsRaw > 5_000 ? 0 : tradingFeeBpsRaw;

  const volume24hRaw = Number(row?.volume_24h ?? 0);
  const volume24h = isSentinel(volume24hRaw) ? 0 : volume24hRaw / collDivisor;

  const insuranceRaw = Number(row?.insurance_fund ?? 0);
  const insuranceFund = insuranceRaw > 0 && insuranceRaw < 1e13 ? insuranceRaw : 0;

  const rawMaxOI = vaultUsd * maxLeverage;
  const maxOI = Math.max(rawMaxOI, totalOI);
  const oiUtilPct = maxOI > 0 ? Math.min((totalOI / maxOI) * 100, 100) : 0;

  return {
    slabAddress: slab,
    symbol,
    name,
    mainnetCa,
    vaultBalance,
    totalOI,
    maxOI,
    insuranceFund,
    volume24h,
    tradingFeeBps,
    maxLeverage,
    oiUtilPct,
    decimals,
  } satisfies MarketVaultInfo;
}

/**
 * Build the Earn-page market list: the 5 curated markets, seeded from
 * PLAYGROUND_SLAB_META (always present, so all 5 always render) PLUS any
 * registered (user-launched) markets that have a real LP Vault Registry on-chain.
 *
 * Each market is enriched with:
 *  - TVL from the on-chain LP Vault Registry (`curatedVaults`) — always accurate.
 *  - Cosmetic stats (volume/insurance/OI/leverage/fees) from Supabase when a row
 *    exists for that slab, else sane defaults (0 / typical playground values).
 *
 * This never falls back to fabricated mock markets — if Supabase has no data for
 * a curated slab, it still renders with real on-chain TVL and zeroed cosmetics,
 * which is strictly more accurate than showing an unrelated fake market.
 *
 * Registered markets are gated on `curatedVaults[slab].found` — a launched market
 * without an on-chain LP Vault Registry yet (no Earn vault created for it) is
 * excluded entirely rather than showing a fabricated $0 entry. The curated 5 have
 * no such gate: they always render (matches prior behavior), since they're the
 * seeded/guaranteed markets even when their registry hasn't been read yet.
 */
function buildCuratedMarkets(
  curatedVaults: Record<string, CuratedVaultOnChain>,
  supabaseBySlab: Map<string, Record<string, unknown>>,
  registeredMarkets: RegisteredMarketMeta[] = [],
  onChainMaxLeverage: Record<string, number> = {},
): MarketVaultInfo[] {
  const curated = Object.entries(PLAYGROUND_SLAB_META)
    .filter(([slab]) => !isBlockedSlab(slab))
    .map(([slab, meta]) =>
      buildMarketVaultInfo(slab, meta.symbol, meta.name, meta.mainnet_ca, curatedVaults, supabaseBySlab, onChainMaxLeverage),
    );

  const curatedSlabs = new Set(Object.keys(PLAYGROUND_SLAB_META));
  const seenRegistered = new Set<string>();
  const registered = registeredMarkets
    // Dedup against the curated set (curated wins) and against duplicate registry rows.
    .filter((m) => !curatedSlabs.has(m.slabAddress) && !isBlockedSlab(m.slabAddress))
    .filter((m) => {
      if (seenRegistered.has(m.slabAddress)) return false;
      seenRegistered.add(m.slabAddress);
      return true;
    })
    // Only show launched markets that actually have an Earn vault on-chain —
    // never a fabricated $0 phantom for a market that hasn't created one yet.
    .filter((m) => curatedVaults[m.slabAddress]?.found === true)
    .map((m) =>
      buildMarketVaultInfo(m.slabAddress, m.symbol, m.name, m.mainnetCa, curatedVaults, supabaseBySlab, onChainMaxLeverage),
    );

  return [...curated, ...registered];
}

/**
 * Compute the platform-wide aggregate fields of `EarnStats` from a market
 * list. Shared by the success path, the cold-start on-chain-failure fallback,
 * and the cold-start catch-block fallback below so the three snapshot-building
 * call sites can't silently drift from each other.
 */
function computeAggregates(markets: MarketVaultInfo[]): Omit<EarnStats, 'markets'> {
  const tvl = markets.reduce((s, m) => s + m.vaultBalance / (10 ** m.decimals), 0);
  const totalOI = markets.reduce((s, m) => s + m.totalOI, 0);
  const maxOI = markets.reduce((s, m) => s + m.maxOI, 0);
  const totalInsurance = markets.reduce((s, m) => s + m.insuranceFund / (10 ** m.decimals), 0);
  const dailyFeeRevenue = markets.reduce(
    (s, m) => s + (m.volume24h * m.tradingFeeBps) / 10_000,
    0,
  );
  return {
    tvl,
    totalOI,
    maxOI,
    oiUtilPct: maxOI > 0 ? (totalOI / maxOI) * 100 : 0,
    totalInsurance,
    dailyFeeRevenue,
  };
}

// ═══════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════

export function useEarnStats() {
  const [stats, setStats] = useState<EarnStats>(DEFAULT_STATS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mockMode = isMockMode();

  // PERC-9204: requestId/generation guard. fetchStats has several sequential
  // awaits (registered-markets fetch, curatedVaults+maxLeverage batch,
  // Supabase query) on a 15s poll — without this, an overlapping (out-of-
  // order) response, or a response resolving after unmount, could
  // setStats/setError/setLoading using stale data. The polling effect's
  // cleanup below also bumps this on unmount for the same reason.
  const requestIdRef = useRef(0);

  // PERC-9204: keep-last-good gate — flips true once a fully successful
  // on-chain fetch cycle has been published to `stats`. A later cycle that
  // hits an on-chain RPC failure checks this before deciding whether to skip
  // publishing (leaving the last good snapshot on screen) or, on a cold
  // start where there's nothing good to preserve yet, fall back to a
  // best-effort zeroed snapshot instead.
  const hasGoodStatsRef = useRef(false);

  const fetchStats = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const stale = () => requestId !== requestIdRef.current;

    if (mockMode) {
      if (stale()) return;
      setStats(generateMockStats());
      setLoading(false);
      return;
    }

    try {
      // Registered (user-launched) markets — fetched from the registration Blob
      // endpoint so their Earn vaults can be seeded alongside the 5 curated ones.
      // Never throws (see fetchRegisteredMarketsMeta); degrades to [] on failure,
      // which just means the Earn page shows the curated 5, same as before.
      const registeredMarkets = await fetchRegisteredMarketsMeta();
      if (stale()) return;

      // On-chain LP Vault Registry TVL is the accuracy-critical piece — fetch it
      // unconditionally, independent of Supabase's availability, over the union of
      // curated ∪ registered slabs. This is what keeps the Earn list accurate for
      // the 5 curated playground markets even when the indexer/DB has no rows for
      // them yet (verified 2026-07-07: this local environment's Supabase
      // credentials are blank, which previously caused this hook to render 4
      // fabricated mock markets instead of the 5 real curated ones), while also
      // surfacing any launched market that has created a real Earn vault.
      const allSlabs = Array.from(
        new Set([
          ...Object.keys(PLAYGROUND_SLAB_META),
          ...registeredMarkets.map((m) => m.slabAddress),
        ]),
      );
      // Max leverage is likewise read straight from each slab's real on-chain
      // initialMarginBps (accuracy-critical, same rationale as curatedVaults
      // above) — fetched in parallel, independent of Supabase's availability.
      const [curatedVaultsResult, maxLeverageResult] = await Promise.all([
        fetchCuratedVaultsOnChain(allSlabs),
        fetchOnChainMaxLeverage(allSlabs),
      ]);
      if (stale()) return;
      const curatedVaults = curatedVaultsResult.data;
      const onChainMaxLeverage = maxLeverageResult.data;
      // PERC-9204: a failed batch means THIS cycle's data isn't trustworthy —
      // see the keep-last-good branch below, not per-slab "not found" (which
      // both functions already treat as a legitimate, non-error default).
      const onChainFailed = !curatedVaultsResult.ok || !maxLeverageResult.ok;

      // Supabase is optional enrichment only (name/volume/OI/insurance) — never
      // a hard requirement for the curated market list, its TVL, or its leverage.
      let supabaseBySlab = new Map<string, Record<string, unknown>>();
      try {
        const supabase = getSupabase();
        const { data, error: dbError } = await supabase
          .from('markets_with_stats')
          .select('*');
        if (!dbError && data) {
          supabaseBySlab = new Map(
            data
              .filter((m) => !!m.slab_address)
              .map((m) => [m.slab_address as string, m as Record<string, unknown>]),
          );
        }
      } catch {
        // No Supabase configured, or the query failed — enrichment degrades to
        // defaults (0 volume/OI/insurance, typical fee), same spirit as
        // PLAYGROUND.md's "external indexer is optional" guarantee elsewhere.
      }
      if (stale()) return;

      if (onChainFailed && hasGoodStatsRef.current) {
        // Keep-last-good: a real snapshot is already on screen — a transient
        // RPC hiccup on THIS 15s poll must not blank the whole Earn page back
        // to $0 TVL / vanished markets. Leave `stats` untouched; just surface
        // the error so a consumer can show a subtle "stale data" indicator.
        setError('Failed to refresh on-chain data — showing last known values');
        return;
      }

      const markets = buildCuratedMarkets(curatedVaults, supabaseBySlab, registeredMarkets, onChainMaxLeverage);
      setStats({ markets, ...computeAggregates(markets) });

      if (onChainFailed) {
        // Cold start (no good snapshot published yet) — still show the
        // best-effort (zeroed-where-unread) curated markets rather than
        // nothing, but don't mark this as "good": if the NEXT cycle also
        // fails, we want to keep retrying this fallback rather than
        // incorrectly gate on a snapshot that was never actually good.
        setError('Failed to refresh on-chain data — showing last known values');
      } else {
        setError(null);
        hasGoodStatsRef.current = true;
      }
    } catch (e) {
      if (stale()) return;
      if (hasGoodStatsRef.current) {
        // Keep-last-good applies here too — an unexpected exception
        // elsewhere in this cycle shouldn't blank an already-good Earn page.
        setError(e instanceof Error ? e.message : 'Failed to load earn stats');
        return;
      }
      setError(e instanceof Error ? e.message : 'Failed to load earn stats');
      // Total failure on a cold start (e.g. RPC unreachable before any good
      // snapshot exists) — still show the 5 curated markets with zeroed
      // stats rather than fabricated mock ones.
      const markets = buildCuratedMarkets({}, new Map());
      setStats({ markets, ...computeAggregates(markets) });
    } finally {
      if (!stale()) setLoading(false);
    }
  }, [mockMode]);

  // Auto-refresh using ref
  const fetchRef = useRef(fetchStats);
  useEffect(() => {
    fetchRef.current = fetchStats;
  }, [fetchStats]);

  useEffect(() => {
    const doFetch = () => fetchRef.current();
    doFetch();
    // Visibility-gated: a backgrounded tab shouldn't keep hitting the
    // rate-limited devnet RPC every 15s for an Earn page nobody is looking
    // at. Fires immediately on tab re-focus (catch-up refresh).
    const dispose = pollWhenVisible(doFetch, 15_000);
    return () => {
      dispose();
      // Invalidate any fetch still in flight so its resolution can't
      // setStats/setError/setLoading after unmount.
      requestIdRef.current++;
    };
  }, []);

  return { stats, loading, error, refresh: fetchStats };
}
