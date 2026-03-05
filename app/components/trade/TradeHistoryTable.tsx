"use client";

import { useTradeHistory } from "@/hooks/useTradeHistory";
import { formatTokenAmount } from "@/lib/format";
import { useMultiTokenMeta } from "@/hooks/useMultiTokenMeta";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

interface TradeHistoryTableProps {
  wallet: string | null | undefined;
  slabFilter?: string;
  /** Maximum rows to show (default 20, loads more on demand) */
  pageSize?: number;
}

function formatPrice(priceNum: number): string {
  if (!priceNum) return "—";
  if (priceNum >= 1000) return `$${priceNum.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (priceNum >= 1) return `$${priceNum.toFixed(4)}`;
  return `$${priceNum.toPrecision(4)}`;
}

function formatFee(feeNum: number): string {
  if (!feeNum) return "—";
  // fee is stored in token base units (e6 scale) — formatTokenAmount expects bigint
  try {
    return formatTokenAmount(BigInt(Math.round(feeNum)), 6);
  } catch {
    return (feeNum / 1_000_000).toFixed(6);
  }
}

function formatSize(sizeStr: string): string {
  try {
    const raw = BigInt(sizeStr.split(".")[0]);
    const abs = raw < 0n ? -raw : raw;
    return formatTokenAmount(abs, 6);
  } catch {
    const n = Math.abs(parseFloat(sizeStr) || 0);
    return formatTokenAmount(BigInt(Math.round(n)), 6);
  }
}

function timeAgo(isoStr: string): string {
  const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export function TradeHistoryTable({
  wallet,
  slabFilter,
  pageSize = 20,
}: TradeHistoryTableProps) {
  const { trades, total, loading, error, hasMore, loadMore } = useTradeHistory({
    wallet,
    limit: pageSize,
    slabFilter,
  });

  // Collect unique slab addresses to resolve market symbols
  const slabAddresses = [...new Set(trades.map((t) => t.slab_address))];
  const tokenMetaMap = useMultiTokenMeta(
    // useMultiTokenMeta expects PublicKey-like strings or empty strings
    // The portfolio page uses collateralMint, but here we have slab addresses.
    // We'll resolve market symbols via a separate lookup below.
    [],
  );
  void tokenMetaMap; // not used yet — we show slab short address as market id

  if (!wallet) return null;

  if (error) {
    return (
      <div className="border border-dashed border-[var(--short)]/30 bg-[var(--panel-bg)]/50 p-6 text-center">
        <p className="text-[12px] text-[var(--short)]/80">Failed to load trade history: {error}</p>
      </div>
    );
  }

  if (loading && trades.length === 0) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="flex items-center gap-4 border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3"
          >
            <ShimmerSkeleton className="h-4 w-16" />
            <ShimmerSkeleton className="h-4 w-12 rounded" />
            <ShimmerSkeleton className="h-4 w-20" />
            <ShimmerSkeleton className="h-4 w-20" />
            <ShimmerSkeleton className="h-4 w-16" />
            <ShimmerSkeleton className="h-4 w-24 ml-auto" />
          </div>
        ))}
      </div>
    );
  }

  if (!loading && trades.length === 0) {
    return (
      <div className="border border-dashed border-[var(--border)] bg-[var(--panel-bg)]/50 p-8 text-center">
        <p className="text-[13px] text-[var(--text-dim)]">No trades yet</p>
        <p className="mt-1 text-[10px] text-[var(--text-dim)]/60">
          Your executed trades will appear here
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Header row */}
      <div className="hidden sm:grid sm:grid-cols-[1fr_80px_110px_110px_90px_110px_32px] gap-x-4 border-b border-[var(--border)] bg-[var(--bg-elevated)]/50 px-4 py-2">
        {["Market", "Side", "Size", "Price", "Fee", "Time", "Tx"].map((h) => (
          <p
            key={h}
            className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]"
          >
            {h}
          </p>
        ))}
      </div>

      {/* Trade rows */}
      <div className="divide-y divide-[var(--border)] border border-t-0 border-[var(--border)]">
        {trades.map((trade) => {
          const isLong = trade.side === "long";
          const txLink = trade.tx_signature
            ? `https://solscan.io/tx/${trade.tx_signature}?cluster=devnet`
            : null;

          return (
            <div
              key={trade.id}
              className="grid grid-cols-2 gap-x-4 gap-y-1.5 bg-[var(--panel-bg)] px-4 py-3 transition-colors duration-100 hover:bg-[var(--bg-elevated)] sm:grid-cols-[1fr_80px_110px_110px_90px_110px_32px] sm:items-center sm:gap-y-0"
            >
              {/* Market (slab short address) */}
              <div className="sm:truncate">
                <p
                  className="text-[11px] font-medium text-white"
                  style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
                  title={trade.slab_address}
                >
                  {shortAddress(trade.slab_address)}/USD
                </p>
              </div>

              {/* Side */}
              <div>
                <span
                  className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold ${
                    isLong
                      ? "bg-[var(--long)]/10 text-[var(--long)]"
                      : "bg-[var(--short)]/10 text-[var(--short)]"
                  }`}
                >
                  {isLong ? "LONG" : "SHORT"}
                </span>
              </div>

              {/* Size */}
              <div>
                <p
                  className="text-[11px] text-white"
                  style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
                >
                  {formatSize(trade.size)}
                </p>
              </div>

              {/* Price */}
              <div>
                <p
                  className="text-[11px] text-[var(--text-secondary)]"
                  style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
                >
                  {formatPrice(trade.price)}
                </p>
              </div>

              {/* Fee */}
              <div>
                <p
                  className="text-[11px] text-[var(--text-secondary)]"
                  style={{ fontFamily: "var(--font-jetbrains-mono)", fontVariantNumeric: "tabular-nums" }}
                >
                  {formatFee(trade.fee)}
                </p>
              </div>

              {/* Time */}
              <div>
                <p
                  className="text-[10px] text-[var(--text-dim)]"
                  title={new Date(trade.created_at).toLocaleString()}
                >
                  {timeAgo(trade.created_at)}
                </p>
              </div>

              {/* Tx link */}
              <div className="flex items-center">
                {txLink ? (
                  <a
                    href={txLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-[var(--accent)]/60 transition-colors hover:text-[var(--accent)]"
                    title={trade.tx_signature ?? ""}
                    aria-label="View on Solscan"
                  >
                    ↗
                  </a>
                ) : (
                  <span className="text-[10px] text-[var(--text-dim)]/40">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer: total count + load more */}
      <div className="mt-3 flex items-center justify-between">
        <p className="text-[10px] text-[var(--text-dim)]">
          Showing {trades.length} of {total} trades
        </p>
        {hasMore && (
          <button
            onClick={loadMore}
            disabled={loading}
            className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-1.5 text-[11px] text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/40 hover:text-[var(--text)] disabled:opacity-40"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
