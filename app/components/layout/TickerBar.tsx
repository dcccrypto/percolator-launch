"use client";

import { FC, useEffect, useState } from "react";
import { useMarketDiscovery } from "@/hooks/useMarketDiscovery";
import { supabase } from "@/lib/supabase";
import type { MarketWithStats } from "@/lib/supabase";

interface TickerItem {
  symbol: string;
  price: number | null;
  change24h: number | null;
}

export const TickerBar: FC = () => {
  const { markets: discovered } = useMarketDiscovery();
  const [items, setItems] = useState<TickerItem[]>([]);

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from("markets_with_stats").select("*");
      if (!data) return;
      const map = new Map<string, MarketWithStats>();
      for (const m of data) map.set(m.slab_address, m);

      const tickers: TickerItem[] = discovered.map((d) => {
        const addr = d.slabAddress.toBase58();
        const sb = map.get(addr);
        return {
          symbol: sb?.symbol ?? addr.slice(0, 6),
          price: sb?.last_price ?? null,
          change24h: sb?.price_change_24h ?? null,
        };
      });
      setItems(tickers);
    }
    if (discovered.length > 0) load();
  }, [discovered]);

  if (items.length === 0) return null;

  const renderItem = (item: TickerItem, i: number) => {
    const isGain = (item.change24h ?? 0) >= 0;
    const color = isGain ? "#00FFB2" : "#FF4466";
    const arrow = isGain ? "▲" : "▼";
    const changeStr = item.change24h != null ? `${arrow} ${Math.abs(item.change24h).toFixed(2)}%` : "";
    const priceStr = item.price != null
      ? `$${item.price < 0.01 ? item.price.toFixed(6) : item.price < 1 ? item.price.toFixed(4) : item.price.toFixed(2)}`
      : "—";

    return (
      <span key={i} className="inline-flex items-center gap-1.5 whitespace-nowrap px-4">
        <span className="text-[#71717a]">{item.symbol}</span>
        <span className="text-[#fafafa]">{priceStr}</span>
        {changeStr && <span style={{ color }}>{changeStr}</span>}
        <span className="text-[#1a1a1f]">•</span>
      </span>
    );
  };

  // Duplicate items for seamless loop
  const content = [...items, ...items, ...items, ...items];

  return (
    <div className="sticky top-0 z-[60] h-7 overflow-hidden border-b border-[#1a1a1f] bg-[#0a0a0f]">
      <div className="ticker-scroll flex h-full items-center text-xs" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
        {content.map((item, i) => renderItem(item, i))}
      </div>

      <style jsx>{`
        .ticker-scroll {
          animation: ticker-slide 30s linear infinite;
          width: max-content;
        }
        @keyframes ticker-slide {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .ticker-scroll:hover {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  );
};
