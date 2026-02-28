'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getBackendUrl } from '@/lib/config';
import { getSupabase } from '@/lib/supabase';
import { isMockMode } from '@/lib/mock-mode';

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
      oiUtilPct: 18.1,
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
      oiUtilPct: 13.0,
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
      oiUtilPct: 18.8,
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
      oiUtilPct: 12.4,
    },
  ];

  const tvl = markets.reduce((s, m) => s + m.vaultBalance / 1e9, 0);
  const totalOI = markets.reduce((s, m) => s + m.totalOI, 0);
  const maxOI = markets.reduce((s, m) => s + m.maxOI, 0);
  const totalInsurance = markets.reduce((s, m) => s + m.insuranceFund / 1e9, 0);
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
      let supabase: ReturnType<typeof getSupabase>;
      try {
        supabase = getSupabase();
      } catch {
        // No Supabase — use mock data
        setStats(generateMockStats());
        setLoading(false);
        return;
      }

      const { data, error: dbError } = await supabase
        .from('markets_with_stats')
        .select('*');

      if (dbError) {
        throw new Error(dbError.message);
      }

      if (!data || data.length === 0) {
        // No markets — show mock
        setStats(generateMockStats());
        setLoading(false);
        return;
      }

      const markets: MarketVaultInfo[] = data
        .filter((m) => m.status === 'active' || m.status === 'Active')
        .map((m) => {
          const oiLong = m.open_interest_long ?? 0;
          const oiShort = m.open_interest_short ?? 0;
          const totalOI = m.total_open_interest ?? oiLong + oiShort;
          const maxLeverage = m.max_leverage ?? 10;
          const vaultBalance = m.lp_collateral ?? 0;
          const tradingFeeBps = m.trading_fee_bps ?? 10;
          const volume24h = m.volume_24h ?? 0;
          const insurance = m.insurance_fund ?? 0;

          // Max OI = vault collateral × max leverage (simplified)
          const vaultUsd = vaultBalance / 1e6; // collateral in USDC (6 decimals)
          const maxOI = vaultUsd * maxLeverage;
          const oiUtilPct = maxOI > 0 ? (totalOI / maxOI) * 100 : 0;

          // Estimated APY: (daily fees × 365) / TVL × 100
          const dailyFees = (volume24h * tradingFeeBps) / 10_000;
          const annualFees = dailyFees * 365;
          const estimatedApyPct =
            vaultUsd > 0 ? (annualFees / vaultUsd) * 100 : 0;

          return {
            slabAddress: m.slab_address ?? '',
            symbol: m.symbol ?? 'UNKNOWN',
            name: m.name ?? m.symbol ?? 'Unknown',
            vaultBalance,
            totalOI,
            maxOI,
            insuranceFund: insurance,
            volume24h,
            tradingFeeBps,
            maxLeverage,
            estimatedApyPct: Math.min(estimatedApyPct, 999), // cap display
            oiUtilPct: Math.min(oiUtilPct, 100),
          };
        });

      const tvl = markets.reduce((s, m) => s + m.vaultBalance / 1e6, 0);
      const totalOI = markets.reduce((s, m) => s + m.totalOI, 0);
      const maxOI = markets.reduce((s, m) => s + m.maxOI, 0);
      const totalInsurance = markets.reduce(
        (s, m) => s + m.insuranceFund / 1e6,
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
      // Fall back to mock data on error
      setStats(generateMockStats());
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
