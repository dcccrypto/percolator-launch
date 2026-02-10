"use client";

import { FC, useEffect, useState, useCallback } from "react";
import { formatTokenAmount } from "@/lib/format";
import { explorerTxUrl } from "@/lib/config";

interface Trade {
  id: string;
  slab_address: string;
  side: "long" | "short";
  size: number;
  price: number;
  fee: number;
  trader: string;
  tx_signature: string | null;
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
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-[var(--bg-surface)]" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-5">
        <p className="text-xs text-[var(--text-muted)]">{error}</p>
      </div>
    );
  }

  return (
    <div className="p-5">
      <div className="mb-3 flex items-center justify-end">
        <button
          onClick={fetchTrades}
          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          refresh
        </button>
      </div>

      {trades.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)] py-4 text-center">No trades yet</p>
      ) : (
        <div className="overflow-hidden">
          <div className="grid grid-cols-4 gap-2 pb-2 text-[9px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
            <div>Time</div>
            <div>Side</div>
            <div className="text-right">Size</div>
            <div className="text-right">Price</div>
          </div>
          <div className="space-y-px">
            {trades.map((trade) => (
              <a
                key={trade.id}
                href={trade.tx_signature ? explorerTxUrl(trade.tx_signature) : "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="grid grid-cols-4 gap-2 py-1.5 text-xs hover:bg-[var(--border)]/20 transition-colors rounded-sm cursor-pointer"
              >
                <div className="text-[var(--text-muted)]">
                  {formatTime(trade.created_at)}
                </div>
                <div>
                  <span className={trade.side === "long" ? "text-[var(--long)]" : "text-[var(--short)]"}>
                    {trade.side?.toUpperCase() ?? "—"}
                  </span>
                </div>
                <div className="text-right text-[var(--text)]">
                  {trade.size != null ? formatTokenAmount(BigInt(Math.round(Math.abs(trade.size)))) : "—"}
                </div>
                <div className="text-right text-[var(--text-secondary)]">
                  {trade.price != null ? `$${Number(trade.price).toFixed(2)}` : "—"}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
