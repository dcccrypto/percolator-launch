"use client";

import { FC, useMemo, useState, useCallback } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useEngineState } from "@/hooks/useEngineState";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { formatTokenAmount, formatUsd, formatPnl, shortenAddress } from "@/lib/format";
import { AccountKind, computeMarkPnl } from "@percolator/core";

type SortKey = "idx" | "owner" | "direction" | "position" | "entry" | "liqPrice" | "pnl" | "capital" | "margin";
type SortDir = "asc" | "desc";
type Tab = "open" | "idle" | "leaderboard";

interface AccountRow {
  idx: number;
  kind: AccountKind;
  owner: string;
  direction: "LONG" | "SHORT" | "IDLE";
  positionSize: bigint;
  entryPrice: bigint;
  liqPrice: bigint;
  liqHealthPct: number;
  pnl: bigint;
  capital: bigint;
  marginPct: number;
}

function computeLiqPrice(entryPrice: bigint, capital: bigint, positionSize: bigint, maintenanceMarginBps: bigint): bigint {
  if (positionSize === 0n || entryPrice === 0n) return 0n;
  const absPos = positionSize < 0n ? -positionSize : positionSize;
  const maintBps = Number(maintenanceMarginBps);
  const capitalPerUnit = Number(capital) * 1e6 / Number(absPos);
  if (positionSize > 0n) {
    const adjusted = capitalPerUnit * 10000 / (10000 + maintBps);
    const liq = Number(entryPrice) - adjusted;
    return liq > 0 ? BigInt(Math.round(liq)) : 0n;
  } else {
    const denom = 10000 - maintBps;
    if (denom <= 0) return 0n;
    const adjusted = capitalPerUnit * 10000 / denom;
    return BigInt(Math.round(Number(entryPrice) + adjusted));
  }
}

/** Compact number: 1234567 → "1.23M", 12345 → "12.3K", 123 → "123" */
function compactNum(n: bigint): string {
  const v = Number(n) / 1e6; // convert from raw to token amount (assuming 6 decimals)
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (Math.abs(v) >= 1) return v.toFixed(2);
  if (Math.abs(v) >= 0.001) return v.toFixed(4);
  return v.toFixed(6);
}

/** Format price_e6 compactly: $1.00, $0.0012, $18,182.81 */
function compactPrice(e6: bigint): string {
  if (e6 === 0n) return "—";
  const v = Number(e6) / 1e6;
  if (v >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

function liqBarColor(pct: number): string {
  if (pct >= 70) return "bg-[var(--long)]";
  if (pct >= 40) return "bg-[var(--warning)]";
  return "bg-[var(--short)]";
}

export const AccountsCard: FC = () => {
  const { accounts, config: mktConfig, loading } = useSlabState();
  const { params } = useEngineState();
  const { priceE6: livePriceE6 } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const [tab, setTab] = useState<Tab>("open");
  const [sortKey, setSortKey] = useState<SortKey>("position");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const oraclePrice = livePriceE6 ?? mktConfig?.lastEffectivePriceE6 ?? 0n;
  const maintBps = params?.maintenanceMarginBps ?? 500n;

  const rows: AccountRow[] = useMemo(() => {
    return accounts.map(({ idx, account }) => {
      const direction: "LONG" | "SHORT" | "IDLE" = account.positionSize > 0n ? "LONG" : account.positionSize < 0n ? "SHORT" : "IDLE";
      const liqPrice = computeLiqPrice(account.entryPrice, account.capital, account.positionSize, maintBps);
      let liqHealthPct = 100;
      if (account.positionSize !== 0n && liqPrice > 0n && oraclePrice > 0n) {
        if (account.positionSize > 0n) {
          const range = Number(account.entryPrice - liqPrice);
          const dist = Number(oraclePrice - liqPrice);
          liqHealthPct = range > 0 ? Math.max(0, Math.min(100, (dist / range) * 100)) : 0;
        } else {
          const range = Number(liqPrice - account.entryPrice);
          const dist = Number(liqPrice - oraclePrice);
          liqHealthPct = range > 0 ? Math.max(0, Math.min(100, (dist / range) * 100)) : 0;
        }
      }
      // Compute PnL from current price (not stale on-chain pnl)
      const computedPnl = account.positionSize !== 0n && oraclePrice > 0n
        ? computeMarkPnl(account.positionSize, account.entryPrice, oraclePrice)
        : account.pnl;
      // Margin uses equity (capital + pnl) for accurate health
      const equity = account.capital + computedPnl;
      const absPos = account.positionSize < 0n ? -account.positionSize : account.positionSize;
      const notional = Number(absPos) * Number(oraclePrice) / 1e6;
      const marginPct = notional > 0 ? (Number(equity) / notional) * 100 : 100;
      return { idx, kind: account.kind, owner: account.owner.toBase58(), direction, positionSize: account.positionSize, entryPrice: account.entryPrice, liqPrice, liqHealthPct, pnl: computedPnl, capital: account.capital, marginPct };
    });
  }, [accounts, maintBps, oraclePrice]);

  const openPositions = useMemo(() => rows.filter((r) => r.direction !== "IDLE"), [rows]);
  const idleAccounts = useMemo(() => rows.filter((r) => r.direction === "IDLE"), [rows]);
  const leaderboard = useMemo(() => [...openPositions].sort((a, b) => Number(b.pnl) - Number(a.pnl)), [openPositions]);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) { setSortDir((d) => d === "asc" ? "desc" : "asc"); return key; }
      setSortDir("desc"); return key;
    });
  }, []);

  const sortedRows = useMemo(() => {
    const base = tab === "open" ? openPositions : tab === "idle" ? idleAccounts : leaderboard;
    const sorted = [...base];
    const dir = sortDir === "asc" ? 1 : -1;
    sorted.sort((a, b) => {
      switch (sortKey) {
        case "idx": return (a.idx - b.idx) * dir;
        case "owner": return a.owner.localeCompare(b.owner) * dir;
        case "direction": return a.direction.localeCompare(b.direction) * dir;
        case "position": return Number(a.positionSize - b.positionSize) * dir;
        case "entry": return Number(a.entryPrice - b.entryPrice) * dir;
        case "liqPrice": return Number(a.liqPrice - b.liqPrice) * dir;
        case "pnl": return Number(a.pnl - b.pnl) * dir;
        case "capital": return Number(a.capital - b.capital) * dir;
        case "margin": return (a.marginPct - b.marginPct) * dir;
        default: return 0;
      }
    });
    return sorted;
  }, [tab, openPositions, idleAccounts, leaderboard, sortKey, sortDir]);

  if (loading) return <div className="p-4"><p className="text-sm text-[var(--text-secondary)]">Loading…</p></div>;

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "open", label: "Open", count: openPositions.length },
    { key: "idle", label: "Idle", count: idleAccounts.length },
    { key: "leaderboard", label: "Leaderboard", count: openPositions.length },
  ];

  const isOpenLike = tab === "open" || tab === "leaderboard";

  const SortHeader: FC<{ label: string; sKey: SortKey; className?: string }> = ({ label, sKey, className = "" }) => (
    <th
      onClick={() => toggleSort(sKey)}
      className={`cursor-pointer select-none whitespace-nowrap px-2 py-2 text-[10px] font-medium uppercase tracking-wider transition-colors hover:text-[var(--text-secondary)] ${className}`}
    >
      {label}
      {sortKey === sKey ? (
        <span className="ml-0.5 text-[var(--accent)]">{sortDir === "asc" ? "↑" : "↓"}</span>
      ) : (
        <span className="ml-0.5 text-[var(--border)]">↕</span>
      )}
    </th>
  );

  return (
    <div className="p-4">
      {/* Tabs */}
      <div className="mb-3 flex items-center gap-2 border-b border-[var(--border)] pb-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-sm px-2.5 py-1 text-[11px] font-medium transition-all ${
              tab === t.key ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "text-[var(--text-secondary)] hover:text-[var(--text)]"
            }`}
          >
            {t.label} <span className="text-[var(--text-muted)]">({t.count})</span>
          </button>
        ))}
        <span className="ml-auto text-[10px] text-[var(--text-muted)]" style={{ fontFamily: "var(--font-mono)" }}>
          {accounts.length} total
        </span>
      </div>

      {sortedRows.length === 0 ? (
        <p className="py-6 text-center text-sm text-[var(--text-secondary)]">
          {tab === "open" ? "No open positions" : tab === "idle" ? "No idle accounts" : "No data"}
        </p>
      ) : (
        <div className="overflow-x-auto -mx-4 px-4">
          <table className="w-full border-collapse" style={{ minWidth: isOpenLike ? "720px" : "400px" }}>
            <thead>
              <tr className="text-[var(--text-muted)]">
                <SortHeader label="#" sKey="idx" className="text-left w-[40px]" />
                <SortHeader label="Owner" sKey="owner" className="text-left w-[100px]" />
                {isOpenLike && <SortHeader label="Side" sKey="direction" className="text-left w-[60px]" />}
                {isOpenLike && <SortHeader label="Size" sKey="position" className="text-right w-[90px]" />}
                {isOpenLike && <SortHeader label="Entry" sKey="entry" className="text-right w-[80px]" />}
                {isOpenLike && <SortHeader label="Liq" sKey="liqPrice" className="text-right w-[100px]" />}
                <SortHeader label="PnL" sKey="pnl" className="text-right w-[80px]" />
                <SortHeader label="Capital" sKey="capital" className="text-right w-[80px]" />
                {isOpenLike && <SortHeader label="Margin" sKey="margin" className="text-right w-[70px]" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]/50">
              {sortedRows.map((row, i) => {
                const absPos = row.positionSize < 0n ? -row.positionSize : row.positionSize;
                return (
                  <tr key={row.idx} className="hover:bg-[var(--accent)]/[0.04] transition-colors">
                    {/* # */}
                    <td className="whitespace-nowrap px-2 py-2 text-[11px] text-[var(--text-muted)]">
                      {i + 1}
                    </td>

                    {/* Owner */}
                    <td className="whitespace-nowrap px-2 py-2 text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                      {shortenAddress(row.owner)}
                    </td>

                    {/* Side */}
                    {isOpenLike && (
                      <td className="whitespace-nowrap px-2 py-2">
                        {row.direction === "IDLE" ? (
                          <span className="text-[11px] text-[var(--text-muted)]">—</span>
                        ) : (
                          <span className={`inline-block rounded px-1.5 py-0.5 text-[9px] font-bold ${
                            row.direction === "LONG" ? "bg-[var(--long)]/10 text-[var(--long)]" : "bg-[var(--short)]/10 text-[var(--short)]"
                          }`}>
                            {row.direction === "LONG" ? "↑" : "↓"}
                          </span>
                        )}
                      </td>
                    )}

                    {/* Size */}
                    {isOpenLike && (
                      <td className={`whitespace-nowrap px-2 py-2 text-right text-[11px] ${
                        row.positionSize > 0n ? "text-[var(--long)]" : row.positionSize < 0n ? "text-[var(--short)]" : "text-[var(--text-muted)]"
                      }`} style={{ fontFamily: "var(--font-mono)" }}>
                        {row.positionSize !== 0n ? compactNum(absPos) : "—"}
                      </td>
                    )}

                    {/* Entry */}
                    {isOpenLike && (
                      <td className="whitespace-nowrap px-2 py-2 text-right text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                        {row.entryPrice > 0n ? compactPrice(row.entryPrice) : "—"}
                      </td>
                    )}

                    {/* Liq */}
                    {isOpenLike && (
                      <td className="whitespace-nowrap px-2 py-2 text-right">
                        {row.positionSize !== 0n ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <span className="text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                              {compactPrice(row.liqPrice)}
                            </span>
                            <div className="h-1 w-8 flex-shrink-0 overflow-hidden rounded-full bg-[var(--bg-surface)]">
                              <div className={`h-1 rounded-full ${liqBarColor(row.liqHealthPct)}`} style={{ width: `${Math.max(4, row.liqHealthPct)}%` }} />
                            </div>
                          </div>
                        ) : (
                          <span className="text-[11px] text-[var(--text-muted)]">—</span>
                        )}
                      </td>
                    )}

                    {/* PnL */}
                    <td className={`whitespace-nowrap px-2 py-2 text-right text-[11px] ${
                      row.pnl > 0n ? "text-[var(--long)]" : row.pnl < 0n ? "text-[var(--short)]" : "text-[var(--text-muted)]"
                    }`} style={{ fontFamily: "var(--font-mono)" }}>
                      {formatPnl(row.pnl)}
                    </td>

                    {/* Capital */}
                    <td className="whitespace-nowrap px-2 py-2 text-right text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                      {compactNum(row.capital)}
                    </td>

                    {/* Margin */}
                    {isOpenLike && (
                      <td className={`whitespace-nowrap px-2 py-2 text-right text-[11px] ${
                        row.marginPct > 50 ? "text-[var(--long)]" : row.marginPct > 20 ? "text-[var(--warning)]" : "text-[var(--short)]"
                      }`} style={{ fontFamily: "var(--font-mono)" }}>
                        {row.positionSize !== 0n ? `${row.marginPct.toFixed(1)}%` : "—"}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
