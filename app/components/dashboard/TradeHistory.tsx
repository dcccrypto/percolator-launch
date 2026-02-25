"use client";

import { useState, useMemo } from "react";
import { getMockTradeHistory, type TradeRecord } from "@/lib/mock-dashboard-data";

type TradeType = "all" | "open" | "close" | "liquidation" | "partial-close";
type MarketFilter = "all" | string;

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatUsd(val: number, showSign = false): string {
  const sign = showSign ? (val >= 0 ? "+" : "") : "";
  return `${sign}$${Math.abs(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const PAGE_SIZE = 25;

export function TradeHistory() {
  const allTrades = useMemo(() => getMockTradeHistory(), []);
  const [marketFilter, setMarketFilter] = useState<MarketFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TradeType>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const markets = useMemo(() => {
    const unique = new Set(allTrades.map((t) => t.market));
    return ["all", ...Array.from(unique).sort()];
  }, [allTrades]);

  const filtered = useMemo(() => {
    return allTrades.filter((t) => {
      if (marketFilter !== "all" && t.market !== marketFilter) return false;
      if (typeFilter !== "all" && t.type !== typeFilter) return false;
      if (search && !t.market.toLowerCase().includes(search.toLowerCase()) && !t.txHash.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [allTrades, marketFilter, typeFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleExportCsv = () => {
    const headers = ["Time", "Market", "Side", "Size", "Size USD", "Entry", "Exit", "PnL", "Fees", "Type", "Tx"];
    const rows = filtered.map((t) => [
      new Date(t.timestamp).toISOString(),
      t.market, t.side, t.size, t.sizeUsd, t.entryPrice,
      t.exitPrice ?? "", t.pnl, t.fees, t.type, t.txHash,
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

  return (
    <div className="flex flex-col border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
          Trade History
        </p>
        <button
          onClick={handleExportCsv}
          className="rounded-sm border border-[var(--border)] px-3 py-1 text-[10px] text-[var(--text-muted)] transition-all hover:border-[var(--accent)]/30 hover:text-[var(--text-secondary)]"
        >
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-5 py-3">
        <select
          value={marketFilter}
          onChange={(e) => { setMarketFilter(e.target.value); setPage(1); }}
          className="rounded-sm border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[11px] text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]/30"
        >
          {markets.map((m) => (
            <option key={m} value={m}>{m === "all" ? "All Markets" : m}</option>
          ))}
        </select>
        <select
          value={typeFilter}
          onChange={(e) => { setTypeFilter(e.target.value as TradeType); setPage(1); }}
          className="rounded-sm border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[11px] text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]/30"
        >
          <option value="all">All Types</option>
          <option value="open">Open</option>
          <option value="close">Close</option>
          <option value="liquidation">Liquidation</option>
          <option value="partial-close">Partial Close</option>
        </select>
        <input
          type="text"
          placeholder="Search market or tx..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="flex-1 rounded-sm border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-[11px] text-[var(--text)] placeholder-[var(--text-dim)] outline-none focus:border-[var(--accent)]/30 min-w-[140px]"
        />
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[700px]">
          <thead>
            <tr className="border-b border-[var(--border)] text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
              <th className="px-4 py-3 text-left">Time</th>
              <th className="px-3 py-3 text-left">Market</th>
              <th className="px-3 py-3 text-left">Side</th>
              <th className="px-3 py-3 text-right">Size</th>
              <th className="px-3 py-3 text-right">Entry</th>
              <th className="px-3 py-3 text-right">Exit</th>
              <th className="px-3 py-3 text-right">PnL</th>
              <th className="px-3 py-3 text-right">Fees</th>
              <th className="px-3 py-3 text-left">Type</th>
              <th className="px-3 py-3 text-center">Tx</th>
            </tr>
          </thead>
          <tbody>
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-[12px] text-[var(--text-dim)]">
                  No trades match your filters.
                </td>
              </tr>
            ) : (
              paginated.map((trade) => (
                <tr
                  key={trade.id}
                  className={[
                    "border-b border-[rgba(255,255,255,0.04)] text-[11px] transition-colors hover:bg-[rgba(255,255,255,0.02)]",
                    trade.type === "liquidation" ? "bg-[var(--short)]/[0.04]" : "",
                    trade.pnl >= 0 ? "border-l-2 border-l-[var(--long)]/30" : "border-l-2 border-l-[var(--short)]/30",
                  ].join(" ")}
                >
                  <td className="px-4 py-2.5 text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                    {formatTime(trade.timestamp)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="rounded border border-[var(--accent)]/20 bg-[var(--accent)]/5 px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent)]">
                      {trade.market}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={`text-[10px] font-bold ${
                        trade.side === "long" ? "text-[var(--long)]" : "text-[var(--short)]"
                      }`}
                    >
                      {trade.side.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                    {trade.size}
                    <span className="ml-1 text-[var(--text-dim)]">({formatUsd(trade.sizeUsd)})</span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                    ${trade.entryPrice.toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 text-right text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                    {trade.exitPrice ? `$${trade.exitPrice.toLocaleString()}` : "—"}
                  </td>
                  <td
                    className={`px-3 py-2.5 text-right font-bold ${
                      trade.pnl >= 0 ? "text-[var(--long)]" : "text-[var(--short)]"
                    }`}
                    style={{ fontFamily: "var(--font-jetbrains-mono)" }}
                  >
                    {formatUsd(trade.pnl, true)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-[var(--text-muted)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                    ${trade.fees.toFixed(2)}
                  </td>
                  <td className="px-3 py-2.5">
                    <span
                      className={[
                        "rounded px-1.5 py-0.5 text-[9px] font-bold uppercase",
                        trade.type === "open" ? "bg-[var(--accent)]/10 text-[var(--accent)]" :
                        trade.type === "close" ? "bg-[var(--text-muted)]/20 text-[var(--text-secondary)]" :
                        trade.type === "liquidation" ? "bg-[var(--short)]/10 text-[var(--short)]" :
                        "bg-[var(--warning)]/10 text-[var(--warning)]",
                      ].join(" ")}
                    >
                      {trade.type === "partial-close" ? "Partial" : trade.type}
                      {trade.type === "liquidation" && " ⚠"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center">
                    <a
                      href={`https://explorer.solana.com/tx/${trade.txHash}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
                      title="View on Solana Explorer"
                    >
                      ↗
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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
          <span className="text-[10px] text-[var(--text-muted)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
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
