"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

interface ActivityItem {
  id: string;
  timestamp: string;
  market: string;
  eventType: "new_market" | "trade" | "large_trade" | "liquidation";
  details: string;
}

function eventIcon(type: ActivityItem["eventType"]): string {
  switch (type) {
    case "new_market": return "🚀";
    case "trade": return "📈";
    case "large_trade": return "🐋";
    case "liquidation": return "💀";
  }
}

function eventColor(type: ActivityItem["eventType"]): string {
  switch (type) {
    case "new_market": return "text-emerald-400";
    case "trade": return "text-blue-400";
    case "large_trade": return "text-yellow-400";
    case "liquidation": return "text-red-400";
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

  useEffect(() => {
    async function load() {
      const activities: ActivityItem[] = [];

      // Fetch recent markets (new listings)
      try {
        const { data: markets } = await supabase
          .from("markets")
          .select("slab_address, symbol, name, created_at")
          .order("created_at", { ascending: false })
          .limit(5);

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
          .limit(10);

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

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg border border-white/[0.06] bg-white/[0.05]" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.05] p-8 text-center">
        <p className="text-sm text-slate-500">No recent activity yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-3 rounded-lg border border-white/[0.06] bg-white/[0.05] px-4 py-3"
        >
          <span className="text-lg">{eventIcon(item.eventType)}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-sm font-semibold ${eventColor(item.eventType)}`}>
                {item.market}
              </span>
              <span className="text-sm text-slate-300">{item.details}</span>
            </div>
          </div>
          <span className="whitespace-nowrap text-xs text-slate-500">{timeAgo(item.timestamp)}</span>
        </div>
      ))}
    </div>
  );
}
