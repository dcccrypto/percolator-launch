"use client";

import { FC, useEffect, useRef, useState, useCallback } from "react";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

import { formatTokenAmount, formatUsdFromNumber } from "@/lib/format";
import { explorerTxUrl } from "@/lib/config";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockTrades } from "@/lib/mock-trade-data";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { pollWhenVisible } from "@/lib/pollWhenVisible";

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
  const { config: mktConfig } = useSlabState();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  // Use on-chain decimals — size from API is in raw token units (i128 on-chain)
  const decimals = tokenMeta?.decimals ?? 6;

  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mirrors `trades` for the equality bail below (avoid a stale closure).
  const tradesRef = useRef<Trade[]>([]);
  // Always holds the CURRENTLY RENDERED slab — read at response time (not
  // captured in fetchTrades' closure) so a response for a market the user
  // has since switched away from can detect that it's stale.
  const activeSlabRef = useRef(slabAddress);
  activeSlabRef.current = slabAddress;
  // Monotonic per-call id — guards against a slower earlier request (e.g.
  // manual "refresh" click racing the 15s poll) resolving after a newer one
  // and clobbering it with older data.
  const requestIdRef = useRef(0);

  const fetchTrades = useCallback(async () => {
    const slabForThisRequest = slabAddress;
    const requestId = ++requestIdRef.current;
    // Bails if a slab switch happened, or a newer fetchTrades call has since
    // been issued for the same slab (rapid poll/manual-refresh overlap).
    const isStale = () =>
      activeSlabRef.current !== slabForThisRequest || requestIdRef.current !== requestId;

    if (isMockMode() && isMockSlab(slabAddress)) {
      const mockTrades = getMockTrades(slabAddress) as Trade[];
      if (isStale()) return;
      tradesRef.current = mockTrades;
      setTrades(mockTrades);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/markets/${slabAddress}/trades?limit=25`);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      if (isStale()) return;
      const nextTrades: Trade[] = data.trades ?? [];
      // Equality bail: same first row + same length -> nothing changed.
      // Skips minting a new 25-row array reference (and the re-render it
      // causes) on the common case where a 15s poll returns identical data.
      const prev = tradesRef.current;
      const unchanged =
        prev.length === nextTrades.length &&
        prev[0]?.id === nextTrades[0]?.id &&
        prev[0]?.tx_signature === nextTrades[0]?.tx_signature;
      if (!unchanged) {
        tradesRef.current = nextTrades;
        setTrades(nextTrades);
      }
      setError(null);
    } catch {
      if (isStale()) return;
      // Keep last-good rows on a transient failure; only surface the
      // unavailable state when we have nothing to show. The trade-tape
      // indexer is an optional external dependency on the playground —
      // when it's down this endpoint 404s permanently, and a red
      // "Failed to load trades" error read as the terminal being broken.
      if (tradesRef.current.length === 0) setError("unavailable");
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [slabAddress]);

  useEffect(() => {
    fetchTrades();
    // Pause the 15s poll while the tab is hidden.
    return pollWhenVisible(fetchTrades, 15000);
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
            <ShimmerSkeleton key={i} className="h-6" rounded="none" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    // Quiet empty-style state, not a red error: matches the Positions tab's
    // "No open positions" treatment. "Unavailable" (not "no trades") because
    // trades may exist that we simply can't read while the indexer is down.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
        <p className="text-[11px] text-[var(--text-dim)]">Trade history unavailable</p>
        <p className="text-[9px] text-[var(--text-dim)] opacity-70">
          The trade-tape indexer isn&apos;t reachable right now — trading itself is unaffected.
        </p>
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
                  {trade.size != null ? formatTokenAmount(toBigInt(Math.abs(typeof trade.size === "number" ? trade.size : parseFloat(trade.size))), decimals) : "—"}
                </div>
                <div className="text-right text-[var(--text-muted)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {trade.price != null ? formatUsdFromNumber(Number(trade.price)) : "—"}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
