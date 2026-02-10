"use client";

import { FC, useMemo, useState, useCallback } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useEngineState } from "@/hooks/useEngineState";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { formatTokenAmount, formatUsd, formatPnl, shortenAddress } from "@/lib/format";
import { AccountKind } from "@percolator/core";

type SortKey = "idx" | "owner" | "direction" | "position" | "entry" | "liqPrice" | "pnl";
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
      return { idx, kind: account.kind, owner: account.owner.toBase58(), direction, positionSize: account.positionSize, entryPrice: account.entryPrice, liqPrice, liqHealthPct, pnl: account.pnl, capital: account.capital };
    });
  }, [accounts, maintBps, oraclePrice]);

  const openPositions = useMemo(() => rows.filter((r) => r.direction !== "IDLE"), [rows]);
  const idleAccounts = useMemo(() => rows.filter((r) => r.direction === "IDLE"), [rows]);
  const leaderboard = useMemo(() => [...openPositions].sort((a, b) => Number(b.pnl) - Number(a.pnl)), [openPositions]);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => { if (prev === key) { setSortDir((d) => d === "asc" ? "desc" : "asc"); return key; } setSortDir("desc"); return key; });
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
        default: return 0;
      }
    });
    return sorted;
  }, [tab, openPositions, idleAccounts, leaderboard, sortKey, sortDir]);

  if (loading) return <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-4"><p className="text-xs text-[var(--text-muted)]">Loading...</p></div>;

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "open", label: "Open", count: openPositions.length },
    { key: "idle", label: "Idle", count: idleAccounts.length },
    { key: "leaderboard", label: "Leaderboard", count: openPositions.length },
  ];

  const isOpenLike = tab === "open" || tab === "leaderboard";

  const SortHeader: FC<{ label: string; sKey: SortKey; align?: "left" | "right" }> = ({ label, sKey, align = "right" }) => (
    <th onClick={() => toggleSort(sKey)} className={`cursor-pointer select-none whitespace-nowrap px-2 pb-3 font-medium ${align === "left" ? "text-left" : "text-right"} hover:text-[var(--text-secondary)]`}>
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
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-4">
      <div className="mb-3 flex items-center gap-1.5">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`rounded-sm px-2.5 py-1 text-[11px] font-medium transition-all ${
              tab === t.key ? "border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            }`}>
            {t.label} ({t.count})
          </button>
        ))}
        <span className="ml-auto text-[10px] text-[var(--text-dim)]">{accounts.length} total</span>
      </div>

      {sortedRows.length === 0 ? (
        <p className="py-6 text-center text-xs text-[var(--text-muted)]">
          {tab === "open" ? "No open positions" : tab === "idle" ? "No idle accounts" : "No data"}
        </p>
      ) : (
        <div className="max-h-[420px] overflow-y-auto overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 z-10 bg-[var(--panel-bg)]">
              <tr className="border-b border-[var(--border)] text-[9px] uppercase tracking-wider text-[var(--text-dim)]">
                <SortHeader label="#" sKey="idx" align="left" />
                <SortHeader label="Owner" sKey="owner" align="left" />
                {isOpenLike && <SortHeader label="Side" sKey="direction" align="left" />}
                {isOpenLike && <SortHeader label="Size" sKey="position" />}
                {isOpenLike && <SortHeader label="Entry" sKey="entry" />}
                {isOpenLike && <SortHeader label="Liq" sKey="liqPrice" />}
                <SortHeader label="PnL" sKey="pnl" />
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row, i) => {
                const absPos = row.positionSize < 0n ? -row.positionSize : row.positionSize;
                return (
                  <tr key={row.idx} className="border-b border-[var(--border-subtle)] transition-colors hover:bg-[var(--bg-elevated)]">
                    <td className="whitespace-nowrap px-2 py-4 text-[var(--text-dim)]">{i + 1}</td>
                    <td className="whitespace-nowrap px-2 py-4 text-left text-[var(--text-secondary)]">{shortenAddress(row.owner)}</td>
                    {isOpenLike && (
                      <td className="whitespace-nowrap px-2 py-4 text-left">
                        {row.direction === "IDLE" ? <span className="text-[var(--text-dim)]">-</span> : (
                          <span className={`text-[10px] font-bold ${
                            row.direction === "LONG" ? "text-[var(--long)]" : "text-[var(--short)]"
                          }`}>{row.direction}</span>
                        )}
                      </td>
                    )}
                    {isOpenLike && (
                      <td className={`whitespace-nowrap px-2 py-4 text-right ${row.positionSize > 0n ? "text-[var(--long)]" : row.positionSize < 0n ? "text-[var(--short)]" : "text-[var(--text-dim)]"}`}>
                        {row.positionSize !== 0n ? formatTokenAmount(absPos) : "-"}
                      </td>
                    )}
                    {isOpenLike && <td className="whitespace-nowrap px-2 py-4 text-right text-[var(--text)]">{row.entryPrice > 0n ? formatUsd(row.entryPrice) : "-"}</td>}
                    {isOpenLike && (
                      <td className="whitespace-nowrap px-2 py-4 text-right">
                        {row.positionSize !== 0n ? (
                          <div className="flex items-center justify-end gap-2">
                            <span className="text-[var(--text)]">{formatUsd(row.liqPrice)}</span>
                            <div className="h-2 w-10 rounded-full bg-[var(--border)]">
                              <div className={`h-2 rounded-full ${liqBarColor(row.liqHealthPct)}`} style={{ width: `${Math.max(8, row.liqHealthPct)}%` }} />
                            </div>
                          </div>
                        ) : "-"}
                      </td>
                    )}
                    <td className={`whitespace-nowrap px-2 py-4 text-right ${row.pnl > 0n ? "text-[var(--long)]" : row.pnl < 0n ? "text-[var(--short)]" : "text-[var(--text-dim)]"}`}>
                      {formatPnl(row.pnl)}
                    </td>
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
