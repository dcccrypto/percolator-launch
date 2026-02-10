"use client";

import { FC, useEffect, useState, useCallback } from "react";
import { formatTokenAmount, formatPriceE6 } from "@/lib/format";

interface Trade {
  id: string;
  side: "long" | "short";
  size: number;
  price_e6: number;
  fee: number;
  trader: string;
  tx_signature: string;
  created_at: string;
}

export const TradeHistory: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch(`/api/markets/${slabAddress}/trades?limit=25`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setTrades(data.trades ?? []);
      setError(null);
    } catch {
      setError("Failed to load trades");
    } finally {
      setLoading(false);
    }
  }, [slabAddress]);

  useEffect(() => {
    fetchTrades();
    const interval = setInterval(fetchTrades, 15000);
    return () => clearInterval(interval);
  }, [fetchTrades]);

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  if (loading) {
    return (
      <div className="p-5">
        <h3 className="mb-3 text-sm font-medium text-[#71717a]">Recent Trades</h3>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-white/[0.03]" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-5">
        <h3 className="mb-3 text-sm font-medium text-[#71717a]">Recent Trades</h3>
        <p className="text-xs text-[#3f3f46]">{error}</p>
      </div>
    );
  }

  return (
    <div className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-[#71717a]">Recent Trades</h3>
        <button
          onClick={fetchTrades}
          className="text-[10px] text-[#3f3f46] hover:text-[#71717a] transition-colors"
        >
          refresh
        </button>
      </div>

      {trades.length === 0 ? (
        <p className="text-xs text-[#3f3f46] py-4 text-center">No trades yet</p>
      ) : (
        <div className="overflow-hidden">
          <div className="grid grid-cols-4 gap-2 pb-2 text-[9px] font-medium uppercase tracking-wider text-[#3f3f46]">
            <div>Time</div>
            <div>Side</div>
            <div className="text-right">Size</div>
            <div className="text-right">Price</div>
          </div>
          <div className="space-y-px">
            {trades.map((trade) => (
              <a
                key={trade.id}
                href={trade.tx_signature ? `https://explorer.solana.com/tx/${trade.tx_signature}?cluster=devnet` : "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="grid grid-cols-4 gap-2 py-1.5 text-xs hover:bg-white/[0.02] transition-colors rounded-sm cursor-pointer"
              >
                <div className="text-[#3f3f46]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                  {formatTime(trade.created_at)}
                </div>
                <div>
                  <span className={trade.side === "long" ? "text-[#00FFB2]" : "text-[#FF4466]"}>
                    {trade.side?.toUpperCase() ?? "—"}
                  </span>
                </div>
                <div className="text-right text-[#fafafa]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                  {trade.size != null ? formatTokenAmount(BigInt(Math.round(Math.abs(trade.size)))) : "—"}
                </div>
                <div className="text-right text-[#71717a]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                  {trade.price_e6 != null ? formatPriceE6(BigInt(Math.round(trade.price_e6))) : "—"}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
