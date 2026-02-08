"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { useMarketDiscovery } from "@/hooks/useMarketDiscovery";
import { computeMarketHealth } from "@/lib/health";
import { HealthBadge } from "@/components/market/HealthBadge";
import { formatTokenAmount } from "@/lib/format";
import type { MarketWithStats } from "@/lib/supabase";
import { supabase } from "@/lib/supabase";
import type { DiscoveredMarket } from "@percolator/core";
import { ActivityFeed } from "@/components/market/ActivityFeed";

function formatNum(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(decimals)}`;
}

function shortenAddress(addr: string, chars = 4): string {
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

interface MergedMarket {
  slabAddress: string;
  symbol: string | null;
  name: string | null;
  onChain: DiscoveredMarket;
  supabase: MarketWithStats | null;
}

export default function MarketsPage() {
  const { markets: discovered, loading: discoveryLoading } = useMarketDiscovery();
  const [supabaseMarkets, setSupabaseMarkets] = useState<MarketWithStats[]>([]);
  const [supabaseLoading, setSupabaseLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from("markets_with_stats").select("*");
      setSupabaseMarkets(data || []);
      setSupabaseLoading(false);
    }
    load();
  }, []);

  const merged = useMemo<MergedMarket[]>(() => {
    const sbMap = new Map<string, MarketWithStats>();
    for (const m of supabaseMarkets) {
      sbMap.set(m.slab_address, m);
    }
    return discovered.map((d) => {
      const addr = d.slabAddress.toBase58();
      const sb = sbMap.get(addr) ?? null;
      return {
        slabAddress: addr,
        symbol: sb?.symbol ?? null,
        name: sb?.name ?? null,
        onChain: d,
        supabase: sb,
      };
    });
  }, [discovered, supabaseMarkets]);

  const loading = discoveryLoading && supabaseLoading;

  return (
    <div className="mx-auto max-w-7xl px-4 py-12">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Markets</h1>
          <p className="mt-1 text-slate-400">Perpetual futures for any Solana token</p>
        </div>
        <Link
          href="/launch"
          className="rounded-xl bg-emerald-500 px-6 py-2.5 font-semibold text-white transition-colors hover:bg-emerald-400"
        >
          + Launch Market
        </Link>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl border border-[#1e2433] bg-[#111318]" />
          ))}
        </div>
      ) : merged.length === 0 ? (
        <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-16 text-center">
          <div className="mb-4 text-5xl">🚀</div>
          <h3 className="mb-2 text-xl font-semibold text-white">No markets yet</h3>
          <p className="mb-6 text-slate-400">Be the first to launch a perpetual futures market.</p>
          <Link
            href="/launch"
            className="inline-block rounded-xl bg-emerald-500 px-8 py-3 font-semibold text-white hover:bg-emerald-400"
          >
            Launch First Market
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[#1e2433]">
          {/* Header */}
          <div className="grid grid-cols-8 gap-4 border-b border-[#1e2433] bg-[#0a0b0f] px-6 py-3 text-xs font-medium uppercase tracking-wider text-slate-500">
            <div className="col-span-2">Market</div>
            <div className="text-right">Price</div>
            <div className="text-right">Open Interest</div>
            <div className="text-right">Capital</div>
            <div className="text-right">Insurance</div>
            <div className="text-right">Leverage</div>
            <div className="text-right">Health</div>
          </div>

          {/* Rows */}
          {merged.map((m) => {
            const health = computeMarketHealth(m.onChain.engine);
            const maxLev = m.onChain.params.initialMarginBps > 0n
              ? Math.floor(10000 / Number(m.onChain.params.initialMarginBps))
              : 0;
            const oiTokens = formatTokenAmount(m.onChain.engine.totalOpenInterest);
            const capitalTokens = formatTokenAmount(m.onChain.engine.cTot);
            const insuranceTokens = formatTokenAmount(m.onChain.engine.insuranceFund.balance);
            const lastPrice = m.supabase?.last_price;

            return (
              <Link
                key={m.slabAddress}
                href={`/trade/${m.slabAddress}`}
                className="grid grid-cols-8 gap-4 border-b border-[#1e2433] bg-[#111318] px-6 py-4 transition-colors hover:bg-[#1a1d24]"
              >
                <div className="col-span-2">
                  <div className="font-semibold text-white">
                    {m.symbol ? `${m.symbol}/USD` : shortenAddress(m.slabAddress)}
                  </div>
                  <div className="text-xs text-slate-500">
                    {m.name ?? shortenAddress(m.onChain.config.collateralMint.toBase58())}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-white">
                    {lastPrice != null ? `$${lastPrice < 0.01 ? lastPrice.toFixed(6) : lastPrice < 1 ? lastPrice.toFixed(4) : lastPrice.toFixed(2)}` : "—"}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-slate-300">{oiTokens}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-slate-300">{capitalTokens}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-emerald-400">{insuranceTokens}</div>
                </div>
                <div className="text-right">
                  <div className="text-slate-300">{maxLev}x</div>
                </div>
                <div className="text-right">
                  <HealthBadge level={health.level} />
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {/* Recent Activity */}
      <div className="mt-12">
        <h2 className="mb-4 text-xl font-bold text-white">Recent Activity</h2>
        <ActivityFeed />
      </div>
    </div>
  );
}
