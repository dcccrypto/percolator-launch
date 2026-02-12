"use client";

import { FC, useEffect, useState, useCallback } from "react";
import { formatTokenAmount, formatPriceE6 } from "@/lib/format";
import { explorerTxUrl } from "@/lib/config";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockTrades } from "@/lib/mock-trade-data";

interface Trade {
  id: string;
  side: "long" | "short";
  size: number | string;
  price: number | string;
  fee: number;
  trader: string;
  tx_signature: string;
  created_at: string;
}

function toBigInt(val: number | string | bigint): bigint {
  if (typeof val === "bigint") return val;
  if (typeof val === "string") return BigInt(val.split(".")[0]);
  if (Number.isSafeInteger(val)) return BigInt(val);
  return BigInt(Math.round(val));
}

export const TradeHistory: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTrades = useCallback(async () => {
    if (isMockMode() && isMockSlab(slabAddress)) {
      setTrades(getMockTrades(slabAddress) as Trade[]);
      setLoading(false);
      return;
    }
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
      <div className="p-3">
        <div className="space-y-1">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-6 animate-pulse bg-[var(--border)]/20" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3">
        <p className="text-[10px] text-[var(--text-dim)]">{error}</p>
      </div>
    );
  }

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <button
          onClick={fetchTrades}
          className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)] hover:text-[var(--text-muted)] transition-colors"
        >
          refresh
        </button>
      </div>

      {trades.length === 0 ? (
        <p className="text-[10px] text-[var(--text-dim)] py-3 text-center">No trades yet</p>
      ) : (
        <div className="overflow-hidden">
          <div className="grid grid-cols-4 gap-2 pb-1 text-[8px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)] border-b border-[var(--border)]/30">
            <div>Time</div>
            <div>Side</div>
            <div className="text-right">Size</div>
            <div className="text-right">Price</div>
          </div>
          <div className="divide-y divide-[var(--border)]/15">
            {trades.map((trade) => (
              <a
                key={trade.id}
                href={trade.tx_signature ? explorerTxUrl(trade.tx_signature) : "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="grid grid-cols-4 gap-2 py-1 text-[10px] hover:bg-[var(--accent)]/[0.03] transition-colors cursor-pointer"
              >
                <div className="text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {formatTime(trade.created_at)}
                </div>
                <div>
                  <span className={trade.side === "long" ? "text-[var(--long)]" : "text-[var(--short)]"}>
                    {trade.side?.toUpperCase() ?? "—"}
                  </span>
                </div>
                <div className="text-right text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {trade.size != null ? formatTokenAmount(toBigInt(Math.abs(typeof trade.size === "number" ? trade.size : parseFloat(trade.size)))) : "—"}
                </div>
                <div className="text-right text-[var(--text-muted)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {trade.price != null ? formatPriceE6(BigInt(Math.round(Number(trade.price) * 1e6))) : "—"}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
