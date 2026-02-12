"use client";

import { FC, useMemo, useState, useCallback } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useEngineState } from "@/hooks/useEngineState";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { formatTokenAmount, formatUsd, formatPnl, shortenAddress } from "@/lib/format";
import { AccountKind, computeMarkPnl, computeLiqPrice } from "@percolator/core";

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
      const computedPnl = account.positionSize !== 0n && oraclePrice > 0n
        ? computeMarkPnl(account.positionSize, account.entryPrice, oraclePrice)
        : account.pnl;
      const marginPct = liqHealthPct;
      return { idx, kind: account.kind, owner: account.owner.toBase58(), direction, positionSize: account.positionSize, entryPrice: account.entryPrice, liqPrice, liqHealthPct, pnl: computedPnl, capital: account.capital, marginPct };
    });
  }, [accounts, maintBps, oraclePrice]);

  const openPositions = useMemo(() => rows.filter((r) => r.direction !== "IDLE"), [rows]);
  const idleAccounts = useMemo(() => rows.filter((r) => r.direction === "IDLE"), [rows]);
  const leaderboard = useMemo(() => [...openPositions].sort((a, b) => b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : 0), [openPositions]);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => { if (prev === key) { setSortDir((d) => d === "asc" ? "desc" : "asc"); return key; } setSortDir("desc"); return key; });
  }, []);

  const sortedRows = useMemo(() => {
    const base = tab === "open" ? openPositions : tab === "idle" ? idleAccounts : leaderboard;
    const sorted = [...base];
    const dir = sortDir === "asc" ? 1 : -1;
    const cmpBig = (x: bigint, y: bigint): number => x > y ? 1 : x < y ? -1 : 0;
    sorted.sort((a, b) => {
      switch (sortKey) {
        case "idx": return (a.idx - b.idx) * dir;
        case "owner": return a.owner.localeCompare(b.owner) * dir;
        case "direction": return a.direction.localeCompare(b.direction) * dir;
        case "position": return cmpBig(a.positionSize, b.positionSize) * dir;
        case "entry": return cmpBig(a.entryPrice, b.entryPrice) * dir;
        case "liqPrice": return cmpBig(a.liqPrice, b.liqPrice) * dir;
        case "pnl": return cmpBig(a.pnl, b.pnl) * dir;
        case "capital": return cmpBig(a.capital, b.capital) * dir;
        case "margin": return (a.marginPct - b.marginPct) * dir;
        default: return 0;
      }
    });
    return sorted;
  }, [tab, openPositions, idleAccounts, leaderboard, sortKey, sortDir]);

  if (loading) return <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3"><p className="text-[10px] text-[var(--text-muted)]">Loading...</p></div>;

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "open", label: "Open", count: openPositions.length },
    { key: "idle", label: "Idle", count: idleAccounts.length },
    { key: "leaderboard", label: "Leaderboard", count: openPositions.length },
  ];

  const isOpenLike = tab === "open" || tab === "leaderboard";

  const SortHeader: FC<{ label: string; sKey: SortKey; align?: "left" | "right"; className?: string }> = ({ label, sKey, align = "right", className = "" }) => (
    <th onClick={() => toggleSort(sKey)} className={`cursor-pointer select-none whitespace-nowrap px-2 py-1.5 font-medium ${align === "left" ? "text-left" : "text-right"} hover:text-[var(--text-secondary)] ${className}`}>
      {label}
      {sortKey === sKey ? <span className="ml-0.5 text-[var(--long)]">{sortDir === "asc" ? "^" : "v"}</span> : ""}
    </th>
  );

  function liqBarColor(pct: number): string {
    if (pct >= 70) return "bg-[var(--long)]";
    if (pct >= 40) return "bg-[var(--warning)]";
    return "bg-[var(--short)]";
  }

  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      <div className="mb-2 flex items-center gap-1">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`rounded-none px-2 py-1 text-[9px] font-medium uppercase tracking-[0.15em] transition-all ${
              tab === t.key ? "border-b border-[var(--accent)] text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}>
            {t.label} ({t.count})
          </button>
        ))}
        <span className="ml-auto text-[9px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{accounts.length} total</span>
      </div>

      {sortedRows.length === 0 ? (
        <p className="py-4 text-center text-[10px] text-[var(--text-muted)]">
          {tab === "open" ? "No open positions" : tab === "idle" ? "No idle accounts" : "No data"}
        </p>
      ) : (
        <div className="max-h-[420px] overflow-y-auto overflow-x-auto">
          <table className="min-w-full text-[10px]">
            <thead className="sticky top-0 z-10 bg-[var(--bg)]/95">
              <tr className="border-b border-[var(--border)]/30 text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                <SortHeader label="#" sKey="idx" align="left" />
                <SortHeader label="Owner" sKey="owner" align="left" />
                {isOpenLike && <SortHeader label="Side" sKey="direction" align="left" />}
                {isOpenLike && <SortHeader label="Size" sKey="position" />}
                {isOpenLike && <SortHeader label="Entry" sKey="entry" />}
                {isOpenLike && <SortHeader label="Liq Price" sKey="liqPrice" />}
                <SortHeader label="PnL" sKey="pnl" />
                <SortHeader label="Capital" sKey="capital" />
                {isOpenLike && <SortHeader label="Margin" sKey="margin" />}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, i) => {
                const absPos = row.positionSize < 0n ? -row.positionSize : row.positionSize;
                return (
                  <tr key={row.idx} className="border-b border-[var(--border)]/20 transition-colors hover:bg-[var(--accent)]/[0.03]">
                    <td className="whitespace-nowrap px-2 py-1.5 text-left text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>{i + 1}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-left text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>{shortenAddress(row.owner)}</td>
                    {isOpenLike && (
                      <td className="whitespace-nowrap px-2 py-1.5 text-left">
                        {row.direction === "IDLE" ? <span className="text-[var(--text-dim)]">-</span> : (
                          <span className={`text-[9px] font-bold ${
                            row.direction === "LONG" ? "text-[var(--long)]" : "text-[var(--short)]"
                          }`}>{row.direction}</span>
                        )}
                      </td>
                    )}
                    {isOpenLike && (
                      <td className={`whitespace-nowrap px-2 py-1.5 text-right ${row.positionSize > 0n ? "text-[var(--long)]" : row.positionSize < 0n ? "text-[var(--short)]" : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                        {row.positionSize !== 0n ? formatTokenAmount(absPos) : "-"}
                      </td>
                    )}
                    {isOpenLike && <td className="whitespace-nowrap px-2 py-1.5 text-right text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{row.entryPrice > 0n ? formatUsd(row.entryPrice) : "-"}</td>}
                    {isOpenLike && (
                      <td className="whitespace-nowrap px-2 py-1.5 text-right">
                        {row.positionSize !== 0n ? (
                          <div className="flex items-center justify-end gap-1">
                            <span className="text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{formatUsd(row.liqPrice)}</span>
                            <div className="h-1 w-8 shrink-0 bg-[var(--border)]/50">
                              <div className={`h-1 ${liqBarColor(row.liqHealthPct)}`} style={{ width: `${Math.max(8, row.liqHealthPct)}%` }} />
                            </div>
                          </div>
                        ) : "-"}
                      </td>
                    )}
                    <td className={`whitespace-nowrap px-2 py-1.5 text-right ${row.pnl > 0n ? "text-[var(--long)]" : row.pnl < 0n ? "text-[var(--short)]" : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                      {formatPnl(row.pnl)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{formatTokenAmount(row.capital)}</td>
                    {isOpenLike && (
                      <td className={`whitespace-nowrap px-2 py-1.5 text-right ${row.marginPct > 50 ? "text-[var(--long)]" : row.marginPct > 20 ? "text-[var(--warning)]" : "text-[var(--short)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                        {row.positionSize !== 0n ? `${row.marginPct.toFixed(1)}%` : "-"}
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
