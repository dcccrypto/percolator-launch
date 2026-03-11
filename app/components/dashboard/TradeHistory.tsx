"use client";

/**
 * Dashboard Trade History — wired to real on-chain data via /api/trader/:wallet/trades.
 *
 * Previously used mock data (getMockTradeHistory). Now uses the same API
 * as the portfolio page's TradeHistoryTable but with dashboard-specific layout.
 *
 * Bug 6 fix: "Trader dashboard showing stats but zero transactions"
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import type { TraderTradeEntry } from "@/app/api/trader/[wallet]/trades/route";

type TradeType = "all" | "long" | "short";

function formatTime(ts: string): string {
  const d = new Date(ts);
  return (
    d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    ", " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}

function formatUsd(val: number, showSign = false): string {
  const sign = showSign ? (val >= 0 ? "+" : "") : "";
  return `${sign}$${Math.abs(val).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function shortAddr(addr: string): string {
  return addr.length > 8 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

const PAGE_SIZE = 25;

export function TradeHistory() {
  const { publicKey } = useWalletCompat();
  const wallet = publicKey?.toBase58() ?? null;

  const [trades, setTrades] = useState<TraderTradeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [sideFilter, setSideFilter] = useState<TradeType>("all");

  const offset = (page - 1) * PAGE_SIZE;

  const fetchTrades = useCallback(async () => {
    if (!wallet) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/trader/${wallet}/trades?limit=${PAGE_SIZE}&offset=${offset}`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setTrades(data.trades ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trades");
    } finally {
      setLoading(false);
    }
  }, [wallet, offset]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  const filtered = useMemo(() => {
    if (sideFilter === "all") return trades;
    return trades.filter((t) => t.side === sideFilter);
  }, [trades, sideFilter]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleExportCsv = () => {
    const headers = ["Time", "Market", "Side", "Size", "Price", "Fee", "Tx"];
    const rows = filtered.map((t) => [
      t.created_at,
      t.slab_address,
      t.side,
      t.size,
      t.price,
      t.fee,
      t.tx_signature ?? "",
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `percolator-trades-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!wallet) {
    return (
      <div className="flex flex-col border border-[var(--border)] bg-[var(--panel-bg)]">
        <div className="px-5 py-4 border-b border-[var(--border)]">
          <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
            Trade History
          </p>
        </div>
        <div className="flex flex-col items-center justify-center py-12">
          <p className="text-[13px] text-[var(--text-dim)]">Connect wallet to view trades</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
          Trade History
        </p>
        <button
          onClick={handleExportCsv}
          disabled={filtered.length === 0}
          className="rounded-sm border border-[var(--border)] px-3 py-1 text-[10px] text-[var(--text-muted)] transition-all hover:border-[var(--accent)]/30 hover:text-[var(--text-secondary)] disabled:opacity-30"
        >
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-5 py-3">
        <select
          value={sideFilter}
          onChange={(e) => {
            setSideFilter(e.target.value as TradeType);
          }}
          className="rounded-sm border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[11px] text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]/30"
        >
          <option value="all">All Sides</option>
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--accent)]/30 border-t-[var(--accent)]" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <p className="text-[12px] text-[var(--short)]">{error}</p>
            <button
              onClick={fetchTrades}
              className="text-[11px] text-[var(--accent)] hover:underline"
            >
              Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-[13px] text-[var(--text-dim)]">No trades yet</p>
            <p className="mt-1 text-[10px] text-[var(--text-dim)]/60">
              Your executed trades will appear here once the trade indexer has processed them.
            </p>
            {process.env.NEXT_PUBLIC_SOLANA_NETWORK === "devnet" && (
              <p className="mt-2 text-[10px] text-[var(--warning)]/60">
                ⚠ Devnet: trade indexer may not be running. Trades are on-chain but not yet indexed.
              </p>
            )}
          </div>
        ) : (
          <table className="w-full min-w-[600px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
                <th className="px-4 py-3 text-left">Time</th>
                <th className="px-3 py-3 text-left">Market</th>
                <th className="px-3 py-3 text-left">Side</th>
                <th className="px-3 py-3 text-right">Size</th>
                <th className="px-3 py-3 text-right">Price</th>
                <th className="px-3 py-3 text-right">Fee</th>
                <th className="px-3 py-3 text-center">Tx</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((trade) => (
                <tr
                  key={trade.id}
                  className="border-b border-[rgba(255,255,255,0.04)] text-[11px] transition-colors hover:bg-[rgba(255,255,255,0.02)]"
                >
                  <td
                    className="px-4 py-2.5 text-[var(--text-secondary)]"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    {formatTime(trade.created_at)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="rounded border border-[var(--accent)]/20 bg-[var(--accent)]/5 px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent)]">
                      {shortAddr(trade.slab_address)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`text-[10px] font-bold ${
                        trade.side === "long"
                          ? "text-[var(--long)]"
                          : "text-[var(--short)]"
                      }`}
                    >
                      {trade.side.toUpperCase()}
                    </span>
                  </td>
                  <td
                    className="px-3 py-2.5 text-right text-[var(--text-secondary)]"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    {(Number(trade.size) / 1e6).toLocaleString(undefined, {
                      maximumFractionDigits: 4,
                    })}
                  </td>
                  <td
                    className="px-3 py-2.5 text-right text-[var(--text-secondary)]"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    {formatUsd(trade.price)}
                  </td>
                  <td
                    className="px-3 py-2.5 text-right text-[var(--text-muted)]"
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    {formatUsd(trade.fee)}
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    {trade.tx_signature ? (
                      <a
                        href={`https://explorer.solana.com/tx/${trade.tx_signature}?cluster=devnet`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
                        title="View on Solana Explorer"
                      >
                        ↗
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] px-5 py-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="rounded-sm border border-[var(--border)] px-3 py-1 text-[10px] text-[var(--text-muted)] transition-all hover:border-[var(--accent)]/30 hover:text-[var(--text-secondary)] disabled:opacity-30"
          >
            ← Prev
          </button>
          <span
            className="text-[10px] text-[var(--text-muted)]"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="rounded-sm border border-[var(--border)] px-3 py-1 text-[10px] text-[var(--text-muted)] transition-all hover:border-[var(--accent)]/30 hover:text-[var(--text-secondary)] disabled:opacity-30"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
