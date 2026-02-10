"use client";

import { useEffect, useState, useRef } from "react";
import gsap from "gsap";
import { supabase } from "@/lib/supabase";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

interface ActivityItem {
  id: string;
  timestamp: string;
  market: string;
  eventType: "new_market" | "trade" | "large_trade" | "liquidation";
  details: string;
}

function eventIcon(type: ActivityItem["eventType"]): string {
  switch (type) {
    case "new_market": return "NEW";
    case "trade": return "TRD";
    case "large_trade": return "BIG";
    case "liquidation": return "LIQ";
  }
}

function eventColor(type: ActivityItem["eventType"]): string {
  switch (type) {
    case "new_market": return "text-[var(--long)]";
    case "trade": return "text-[var(--long)]";
    case "large_trade": return "text-[var(--warning)]";
    case "liquidation": return "text-[var(--short)]";
  }
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Shows recent on-chain activity across all markets.
 * Pulls from Supabase trades table + markets for new listings.
 */
export function ActivityFeed() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  useEffect(() => {
    async function load() {
      const activities: ActivityItem[] = [];

      // Fetch recent markets (new listings)
      try {
        const { data: markets } = await supabase
          .from("markets")
          .select("slab_address, symbol, name, created_at")
          .order("created_at", { ascending: false })
          .limit(5) as { data: Array<{ slab_address: string; symbol: string | null; name: string | null; created_at: string }> | null };

        if (markets) {
          for (const m of markets) {
            activities.push({
              id: `market-${m.slab_address}`,
              timestamp: m.created_at,
              market: m.symbol || m.slab_address.slice(0, 8),
              eventType: "new_market",
              details: `${m.name || m.symbol || "New"} market launched`,
            });
          }
        }
      } catch { /* ignore */ }

      // Fetch recent trades
      try {
        const { data: trades } = await supabase
          .from("trades")
          .select("id, slab_address, side, size, price, created_at, tx_sig")
          .order("created_at", { ascending: false })
          .limit(10) as { data: Array<{ id: string; slab_address: string; side: string; size: string; price: string; created_at: string; tx_sig: string }> | null };

        if (trades) {
          for (const t of trades) {
            const sizeNum = parseFloat(t.size || "0");
            const priceNum = parseFloat(t.price || "0");
            const notional = sizeNum * priceNum;
            const isLarge = notional > 10000;

            activities.push({
              id: `trade-${t.id}`,
              timestamp: t.created_at,
              market: t.slab_address?.slice(0, 8) || "?",
              eventType: isLarge ? "large_trade" : "trade",
              details: `${t.side === "long" ? "Long" : "Short"} ${sizeNum.toLocaleString()} @ $${priceNum.toFixed(2)}`,
            });
          }
        }
      } catch { /* ignore */ }

      // Sort by time, take top 10
      activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setItems(activities.slice(0, 10));
      setLoading(false);
    }

    load();
  }, []);

  useEffect(() => {
    if (!loading && items.length > 0 && containerRef.current && !prefersReduced) {
      const children = containerRef.current.children;
      gsap.fromTo(
        children,
        { opacity: 0, y: 10 },
        { opacity: 1, y: 0, stagger: 0.05, duration: 0.3, ease: "power2.out" },
      );
    }
  }, [items, loading, prefersReduced]);

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <ShimmerSkeleton key={i} className="h-14" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-8 text-center">
        <p className="text-sm text-[var(--text-muted)]">No recent activity yet.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-3 rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] hover:bg-[var(--accent)]/[0.06] transition-colors duration-150 px-4 py-3"
        >
          <span className={`text-[10px] font-bold uppercase ${eventColor(item.eventType)}`}>{eventIcon(item.eventType)}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-sm font-semibold ${eventColor(item.eventType)}`}>
                {item.market}
              </span>
              <span className="text-sm text-[var(--text-secondary)]">{item.details}</span>
            </div>
          </div>
          <span className="whitespace-nowrap text-xs text-[var(--text-muted)]">{timeAgo(item.timestamp)}</span>
        </div>
      ))}
    </div>
  );
}
