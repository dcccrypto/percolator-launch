"use client";

import { FC, useMemo, useState, useCallback } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useEngineState } from "@/hooks/useEngineState";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { formatTokenAmount, formatUsd, formatPnl, shortenAddress } from "@/lib/format";
import { AccountKind } from "@percolator/core";

type SortKey = "idx" | "owner" | "direction" | "position" | "entry" | "liqPrice" | "cost" | "pnl" | "capital" | "margin";
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
  cost: bigint;
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
    // Long: liq when price drops — margin threshold on the downside
    const adjusted = capitalPerUnit * 10000 / (10000 + maintBps);
    const liq = Number(entryPrice) - adjusted;
    return liq > 0 ? BigInt(Math.round(liq)) : 0n;
  } else {
    // Short: liq when price rises — use (10000 - maintBps) per core library
    const denom = 10000 - maintBps;
    if (denom <= 0) return 0n;
    const adjusted = capitalPerUnit * 10000 / denom;
    return BigInt(Math.round(Number(entryPrice) + adjusted));
  }
}

function computeMarginPct(capital: bigint, positionSize: bigint, priceE6: bigint): number {
  if (positionSize === 0n || priceE6 === 0n) return 100;
  const absPos = positionSize < 0n ? -positionSize : positionSize;
  const notional = Number(absPos) * Number(priceE6) / 1e6;
  if (notional === 0) return 100;
  return (Number(capital) / notional) * 100;
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
      const absPos = account.positionSize < 0n ? -account.positionSize : account.positionSize;
      const cost = absPos * account.entryPrice / 1_000_000n;
      const marginPct = computeMarginPct(account.capital, account.positionSize, oraclePrice);
      return { idx, kind: account.kind, owner: account.owner.toBase58(), direction, positionSize: account.positionSize, entryPrice: account.entryPrice, liqPrice, liqHealthPct, cost, pnl: account.pnl, capital: account.capital, marginPct };
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
        case "cost": return Number(a.cost - b.cost) * dir;
        case "pnl": return Number(a.pnl - b.pnl) * dir;
        case "capital": return Number(a.capital - b.capital) * dir;
        case "margin": return (a.marginPct - b.marginPct) * dir;
        default: return 0;
      }
    });
    return sorted;
  }, [tab, openPositions, idleAccounts, leaderboard, sortKey, sortDir]);

  if (loading) return <div className="p-4"><p className="text-sm text-[#8B95B0]">Loading…</p></div>;

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "open", label: "Open", count: openPositions.length },
    { key: "idle", label: "Idle", count: idleAccounts.length },
    { key: "leaderboard", label: "Leaderboard", count: openPositions.length },
  ];

  const isOpenLike = tab === "open" || tab === "leaderboard";

  const SortHeader: FC<{ label: string; sKey: SortKey; align?: "left" | "right" }> = ({ label, sKey, align = "right" }) => (
    <th onClick={() => toggleSort(sKey)} className={`cursor-pointer select-none pb-2 font-medium ${align === "left" ? "text-left" : "text-right"} hover:text-[#8B95B0]`}>
      {label}
      {sortKey === sKey ? <span className="ml-0.5 text-[#00FFB2]">{sortDir === "asc" ? "↑" : "↓"}</span> : <span className="ml-0.5 text-[#1a1d2a]">↕</span>}
    </th>
  );

  function liqBarColor(pct: number): string {
    if (pct >= 70) return "bg-[#00e68a]";
    if (pct >= 40) return "bg-[#ffaa00]";
    if (pct >= 20) return "bg-[#ff8800]";
    return "bg-[#ff4d6a]";
  }

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-all ${
              tab === t.key ? "bg-white/[0.06] text-white" : "text-[#8B95B0] hover:text-[#8B95B0]"
            }`}>
            {t.label} <span className="text-[#3D4563]">({t.count})</span>
          </button>
        ))}
        <span className="ml-auto data-cell text-[10px] text-[#3D4563]">{accounts.length} total</span>
      </div>

      {sortedRows.length === 0 ? (
        <p className="py-4 text-center text-sm text-[#8B95B0]">
          {tab === "open" ? "No open positions" : tab === "idle" ? "No idle accounts" : "No data"}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-[9px] uppercase tracking-wider text-[#3D4563]">
                <SortHeader label="#" sKey="idx" align="left" />
                <SortHeader label="Owner" sKey="owner" align="left" />
                {isOpenLike && <SortHeader label="Side" sKey="direction" align="left" />}
                {isOpenLike && <SortHeader label="Position" sKey="position" />}
                {isOpenLike && <SortHeader label="Entry" sKey="entry" />}
                {isOpenLike && <SortHeader label="Liq" sKey="liqPrice" />}
                <SortHeader label="PnL" sKey="pnl" />
                <SortHeader label="Capital" sKey="capital" />
                {isOpenLike && <SortHeader label="Margin" sKey="margin" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {sortedRows.map((row, i) => {
                const absPos = row.positionSize < 0n ? -row.positionSize : row.positionSize;
                return (
                  <tr key={row.idx} className="hover:bg-white/[0.04]">
                    <td className="py-1.5 text-[#3D4563]">{i + 1}</td>
                    <td className="data-cell py-1.5 text-[#8B95B0]">{shortenAddress(row.owner)}</td>
                    {isOpenLike && (
                      <td className="py-1.5">
                        {row.direction === "IDLE" ? <span className="text-[#3D4563]">—</span> : (
                          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                            row.direction === "LONG" ? "bg-[#00e68a]/10 text-[#00e68a]" : "bg-[#ff4d6a]/10 text-[#ff4d6a]"
                          }`}>{row.direction}</span>
                        )}
                      </td>
                    )}
                    {isOpenLike && (
                      <td className={`data-cell py-1.5 text-right ${row.positionSize > 0n ? "text-[#00e68a]" : row.positionSize < 0n ? "text-[#ff4d6a]" : "text-[#3D4563]"}`}>
                        {row.positionSize !== 0n ? formatTokenAmount(absPos) : "—"}
                      </td>
                    )}
                    {isOpenLike && <td className="data-cell py-1.5 text-right text-[#F0F4FF]">{row.entryPrice > 0n ? formatUsd(row.entryPrice) : "—"}</td>}
                    {isOpenLike && (
                      <td className="py-1.5 text-right">
                        {row.positionSize !== 0n ? (
                          <div className="flex items-center justify-end gap-1">
                            <span className="data-cell text-[#F0F4FF]">{formatUsd(row.liqPrice)}</span>
                            <div className="h-1 w-8 rounded-full bg-white/[0.06]">
                              <div className={`h-1 rounded-full ${liqBarColor(row.liqHealthPct)}`} style={{ width: `${Math.max(4, row.liqHealthPct)}%` }} />
                            </div>
                          </div>
                        ) : "—"}
                      </td>
                    )}
                    <td className={`data-cell py-1.5 text-right ${row.pnl > 0n ? "text-[#00e68a]" : row.pnl < 0n ? "text-[#ff4d6a]" : "text-[#3D4563]"}`}>
                      {formatPnl(row.pnl)}
                    </td>
                    <td className="data-cell py-1.5 text-right text-[#F0F4FF]">{formatTokenAmount(row.capital)}</td>
                    {isOpenLike && (
                      <td className={`data-cell py-1.5 text-right ${row.marginPct > 50 ? "text-[#00e68a]" : row.marginPct > 20 ? "text-[#ffaa00]" : "text-[#ff4d6a]"}`}>
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
