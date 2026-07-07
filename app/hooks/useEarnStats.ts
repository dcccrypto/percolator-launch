'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Connection, PublicKey } from '@solana/web3.js';
import { deriveLpVaultRegistry, parseLpVaultRegistry } from '@percolatorct/sdk';
import { getBackendUrl, getConfig, getRpcEndpoint } from '@/lib/config';
import { getSupabase } from '@/lib/supabase';
import { isMockMode } from '@/lib/mock-mode';
import { isBlockedSlab } from '@/lib/blocklist';
import { sanitizeOnChainValue } from '@/lib/health';
import { PLAYGROUND_SLAB_META } from '@/lib/playground-slab-meta';

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface MarketVaultInfo {
  slabAddress: string;
  symbol: string;
  name: string;
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
  /** Annualised APY estimate based on fee revenue */
  estimatedApyPct: number;
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
  /** Platform-wide average APY */
  avgApyPct: number;
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
  avgApyPct: 0,
  oiUtilPct: 0,
  totalInsurance: 0,
  markets: [],
  dailyFeeRevenue: 0,
};

// ═══════════════════════════════════════════════════════════════
// Mock data for devnet / offline
// ═══════════════════════════════════════════════════════════════

function generateMockStats(): EarnStats {
  const markets: MarketVaultInfo[] = [
    {
      slabAddress: 'mock-sol-perp',
      symbol: 'SOL',
      name: 'Solana',
      vaultBalance: 125_000_000_000, // 125 SOL
      totalOI: 45_200,
      maxOI: 250_000,
      insuranceFund: 12_000_000_000,
      volume24h: 128_450,
      tradingFeeBps: 10,
      maxLeverage: 20,
      estimatedApyPct: 18.7,
      oiUtilPct: 18.1, decimals: 9,
    },
    {
      slabAddress: 'mock-bonk-perp',
      symbol: 'BONK',
      name: 'Bonk',
      vaultBalance: 85_000_000_000,
      totalOI: 22_100,
      maxOI: 170_000,
      insuranceFund: 5_000_000_000,
      volume24h: 89_200,
      tradingFeeBps: 15,
      maxLeverage: 10,
      estimatedApyPct: 24.3,
      oiUtilPct: 13.0, decimals: 6,
    },
    {
      slabAddress: 'mock-wif-perp',
      symbol: 'WIF',
      name: 'dogwifhat',
      vaultBalance: 42_000_000_000,
      totalOI: 15_800,
      maxOI: 84_000,
      insuranceFund: 3_500_000_000,
      volume24h: 67_300,
      tradingFeeBps: 15,
      maxLeverage: 10,
      estimatedApyPct: 31.2,
      oiUtilPct: 18.8, decimals: 6,
    },
    {
      slabAddress: 'mock-jup-perp',
      symbol: 'JUP',
      name: 'Jupiter',
      vaultBalance: 38_000_000_000,
      totalOI: 9_400,
      maxOI: 76_000,
      insuranceFund: 2_800_000_000,
      volume24h: 41_600,
      tradingFeeBps: 12,
      maxLeverage: 15,
      estimatedApyPct: 15.8,
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

  const avgApy =
    markets.length > 0
      ? markets.reduce((s, m) => s + m.estimatedApyPct, 0) / markets.length
      : 0;

  return {
    tvl: tvl * 150, // Convert SOL to rough USD at $150
    totalOI,
    maxOI,
    avgApyPct: avgApy,
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
const CURATED_COLLATERAL_DECIMALS = 6;

interface CuratedVaultOnChain {
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
      acc.push({ slabAddress, symbol, name });
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
 */
async function fetchCuratedVaultsOnChain(slabs: string[]): Promise<Record<string, CuratedVaultOnChain>> {
  const result: Record<string, CuratedVaultOnChain> = {};
  for (const slab of slabs) result[slab] = { tvlAtoms: 0n, cooldownSlots: 0n, found: false };
  if (slabs.length === 0) return result;

  try {
    const programId = new PublicKey(getConfig().programId);
    const connection = new Connection(getRpcEndpoint(), 'confirmed');
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
  }

  return result;
}

/**
 * Build a single market's MarketVaultInfo from its on-chain vault data + optional
 * Supabase cosmetic row. Shared by both the curated (PLAYGROUND_SLAB_META) markets
 * and the registered (user-launched) markets below.
 */
function buildMarketVaultInfo(
  slab: string,
  symbol: string,
  name: string,
  curatedVaults: Record<string, CuratedVaultOnChain>,
  supabaseBySlab: Map<string, Record<string, unknown>>,
): MarketVaultInfo {
  const isSentinel = (v: number) => v > 1e18;
  const row = supabaseBySlab.get(slab);
  const decimals = CURATED_COLLATERAL_DECIMALS;
  const collDivisor = 10 ** decimals;

  const vaultAtoms = curatedVaults[slab]?.tvlAtoms ?? 0n;
  const vaultBalance = Number(vaultAtoms); // atoms — matches MarketVaultInfo.vaultBalance convention
  const vaultUsd = vaultBalance / collDivisor;

  const oiLongRaw = Number(row?.open_interest_long ?? 0);
  const oiShortRaw = Number(row?.open_interest_short ?? 0);
  const totalOIRaw = Number(row?.total_open_interest ?? oiLongRaw + oiShortRaw);
  const totalOI = isSentinel(totalOIRaw) ? 0 : totalOIRaw / collDivisor;

  const maxLeverage = Number(row?.max_leverage) || 10;
  const tradingFeeBpsRaw = Number(row?.trading_fee_bps ?? 10);
  const tradingFeeBps = tradingFeeBpsRaw > 5_000 ? 0 : tradingFeeBpsRaw;

  const volume24hRaw = Number(row?.volume_24h ?? 0);
  const volume24h = isSentinel(volume24hRaw) ? 0 : volume24hRaw / collDivisor;

  const insuranceRaw = Number(row?.insurance_fund ?? 0);
  const insuranceFund = insuranceRaw > 0 && insuranceRaw < 1e13 ? insuranceRaw : 0;

  const rawMaxOI = vaultUsd * maxLeverage;
  const maxOI = Math.max(rawMaxOI, totalOI);
  const oiUtilPct = maxOI > 0 ? Math.min((totalOI / maxOI) * 100, 100) : 0;

  const dailyFees = (volume24h * tradingFeeBps) / 10_000;
  const annualFees = dailyFees * 365;
  const estimatedApyPct = vaultUsd > 0 ? Math.min((annualFees / vaultUsd) * 100, 999) : 0;

  return {
    slabAddress: slab,
    symbol,
    name,
    vaultBalance,
    totalOI,
    maxOI,
    insuranceFund,
    volume24h,
    tradingFeeBps,
    maxLeverage,
    estimatedApyPct,
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
): MarketVaultInfo[] {
  const curated = Object.entries(PLAYGROUND_SLAB_META)
    .filter(([slab]) => !isBlockedSlab(slab))
    .map(([slab, meta]) =>
      buildMarketVaultInfo(slab, meta.symbol, meta.name, curatedVaults, supabaseBySlab),
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
      buildMarketVaultInfo(m.slabAddress, m.symbol, m.name, curatedVaults, supabaseBySlab),
    );

  return [...curated, ...registered];
}

// ═══════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════

export function useEarnStats() {
  const [stats, setStats] = useState<EarnStats>(DEFAULT_STATS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mockMode = isMockMode();

  const fetchStats = useCallback(async () => {
    if (mockMode) {
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
      const curatedVaults = await fetchCuratedVaultsOnChain(allSlabs);

      // Supabase is optional enrichment only (name/volume/OI/insurance/leverage)
      // — never a hard requirement for the curated market list or its TVL.
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
        // defaults (0 volume/OI/insurance, typical fee/leverage), same spirit as
        // PLAYGROUND.md's "external indexer is optional" guarantee elsewhere.
      }

      const markets = buildCuratedMarkets(curatedVaults, supabaseBySlab, registeredMarkets);

      const tvl = markets.reduce((s, m) => s + m.vaultBalance / (10 ** m.decimals), 0);
      const totalOI = markets.reduce((s, m) => s + m.totalOI, 0);
      const maxOI = markets.reduce((s, m) => s + m.maxOI, 0);
      const totalInsurance = markets.reduce(
        (s, m) => s + m.insuranceFund / (10 ** m.decimals),
        0,
      );
      const dailyFeeRevenue = markets.reduce(
        (s, m) => s + (m.volume24h * m.tradingFeeBps) / 10_000,
        0,
      );
      const avgApy =
        markets.length > 0
          ? markets.reduce((s, m) => s + m.estimatedApyPct, 0) / markets.length
          : 0;

      setStats({
        tvl,
        totalOI,
        maxOI,
        avgApyPct: avgApy,
        oiUtilPct: maxOI > 0 ? (totalOI / maxOI) * 100 : 0,
        totalInsurance,
        markets,
        dailyFeeRevenue,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load earn stats');
      // Total failure (e.g. RPC unreachable) — still show the 5 curated markets
      // with zeroed stats rather than fabricated mock ones.
      setStats((prev) => ({
        ...prev,
        markets: buildCuratedMarkets({}, new Map()),
      }));
    } finally {
      setLoading(false);
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
    const interval = setInterval(doFetch, 15_000);
    return () => clearInterval(interval);
  }, []);

  return { stats, loading, error, refresh: fetchStats };
}
