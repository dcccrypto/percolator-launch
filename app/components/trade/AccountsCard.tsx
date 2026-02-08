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
type Tab = "open" | "idle" | "leaderboard" | "alltime";

interface AccountRow {
  idx: number;
  kind: AccountKind;
  owner: string;
  direction: "LONG" | "SHORT" | "IDLE";
  positionSize: bigint;
  entryPrice: bigint;
  liqPrice: bigint;
  liqHealthPct: number; // 0..100 how far from liq (100 = safe)
  cost: bigint;
  pnl: bigint;
  capital: bigint;
  marginPct: number;
}

function computeLiqPrice(
  entryPrice: bigint,
  capital: bigint,
  positionSize: bigint,
  maintenanceMarginBps: bigint,
): bigint {
  if (positionSize === 0n || entryPrice === 0n) return 0n;
  const absPos = positionSize < 0n ? -positionSize : positionSize;
  // maintMargin = absPos * price * maintenanceMarginBps / 10000 / 1e6
  // For longs: liqPrice = entryPrice - (capital * 1e6 / absPos) * (10000 / (10000 + maintBps))
  // For shorts: liqPrice = entryPrice + (capital * 1e6 / absPos) * (10000 / (10000 + maintBps))
  // Simplified: liqPrice = entryPrice -/+ (capital * 10000 * 1e6) / (absPos * (10000 + maintBps))
  const maintBps = Number(maintenanceMarginBps);
  const capitalPerUnit = Number(capital) * 1e6 / Number(absPos);
  const adjusted = capitalPerUnit * 10000 / (10000 + maintBps);

  if (positionSize > 0n) {
    // Long: liquidated when price drops
    const liq = Number(entryPrice) - adjusted;
    return liq > 0 ? BigInt(Math.round(liq)) : 0n;
  } else {
    // Short: liquidated when price rises
    return BigInt(Math.round(Number(entryPrice) + adjusted));
  }
}

function computeMarginPct(
  capital: bigint,
  positionSize: bigint,
  priceE6: bigint,
): number {
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
      const direction: "LONG" | "SHORT" | "IDLE" =
        account.positionSize > 0n ? "LONG" : account.positionSize < 0n ? "SHORT" : "IDLE";
      const liqPrice = computeLiqPrice(account.entryPrice, account.capital, account.positionSize, maintBps);
      // Health: how far current price is from liq as % of entry-to-liq range
      let liqHealthPct = 100;
      if (account.positionSize !== 0n && liqPrice > 0n && oraclePrice > 0n) {
        if (account.positionSize > 0n) {
          // Long: healthy if price >> liqPrice
          const range = Number(account.entryPrice - liqPrice);
          const dist = Number(oraclePrice - liqPrice);
          liqHealthPct = range > 0 ? Math.max(0, Math.min(100, (dist / range) * 100)) : 0;
        } else {
          // Short: healthy if price << liqPrice
          const range = Number(liqPrice - account.entryPrice);
          const dist = Number(liqPrice - oraclePrice);
          liqHealthPct = range > 0 ? Math.max(0, Math.min(100, (dist / range) * 100)) : 0;
        }
      }
      // cost = |positionSize| * entryPrice / 1e6
      const absPos = account.positionSize < 0n ? -account.positionSize : account.positionSize;
      const cost = absPos * account.entryPrice / 1_000_000n;
      const marginPct = computeMarginPct(account.capital, account.positionSize, oraclePrice);
      return {
        idx,
        kind: account.kind,
        owner: account.owner.toBase58(),
        direction,
        positionSize: account.positionSize,
        entryPrice: account.entryPrice,
        liqPrice,
        liqHealthPct,
        cost,
        pnl: account.pnl,
        capital: account.capital,
        marginPct,
      };
    });
  }, [accounts, maintBps, oraclePrice]);

  const openPositions = useMemo(() => rows.filter((r) => r.direction !== "IDLE"), [rows]);
  const idleAccounts = useMemo(() => rows.filter((r) => r.direction === "IDLE"), [rows]);

  // Leaderboard: sorted by PnL desc
  const leaderboard = useMemo(
    () => [...openPositions].sort((a, b) => (Number(b.pnl) - Number(a.pnl))),
    [openPositions],
  );

  // All-time: all accounts sorted by capital desc
  const allTime = useMemo(
    () => [...rows].sort((a, b) => (Number(b.capital) - Number(a.capital))),
    [rows],
  );

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return key;
      }
      setSortDir("desc");
      return key;
    });
  }, []);

  const sortedRows = useMemo(() => {
    const base = tab === "open" ? openPositions
      : tab === "idle" ? idleAccounts
      : tab === "leaderboard" ? leaderboard
      : allTime;

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
  }, [tab, openPositions, idleAccounts, leaderboard, allTime, sortKey, sortDir]);

  if (loading) {
    return (
      <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-5">
        <p className="text-sm text-[#71717a]">Loading accounts...</p>
      </div>
    );
  }

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "open", label: "Open Positions", count: openPositions.length },
    { key: "idle", label: "Idle Accounts", count: idleAccounts.length },
    { key: "leaderboard", label: "Leaderboard", count: openPositions.length },
    { key: "alltime", label: "All-Time", count: rows.length },
  ];

  const isOpenLike = tab === "open" || tab === "leaderboard" || tab === "alltime";

  const SortHeader: FC<{ label: string; sKey: SortKey; align?: "left" | "right" }> = ({ label, sKey, align = "right" }) => (
    <th
      onClick={() => toggleSort(sKey)}
      className={`cursor-pointer select-none pb-2 font-medium ${align === "left" ? "text-left" : "text-right"} hover:text-[#71717a]`}
    >
      {label}
      {sortKey === sKey ? (
        <span className="ml-0.5 text-blue-400">{sortDir === "asc" ? "↑" : "↓"}</span>
      ) : (
        <span className="ml-0.5 text-[#3f3f46]">↕</span>
      )}
    </th>
  );

  function liqBarColor(pct: number): string {
    if (pct >= 70) return "bg-emerald-500";
    if (pct >= 40) return "bg-yellow-500";
    if (pct >= 20) return "bg-orange-500";
    return "bg-red-500";
  }

  return (
    <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex gap-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-lg px-3 py-1 text-xs font-medium ${
                tab === t.key ? "bg-blue-600 text-white" : "bg-[#1a1a2e] text-[#71717a] hover:bg-[#1e1e2e]"
              }`}
            >
              {t.label} ({t.count})
            </button>
          ))}
        </div>
        <span className="rounded-full bg-[#1a1a2e] px-2 py-0.5 text-xs text-[#52525b]">
          {accounts.length} total
        </span>
      </div>

      {sortedRows.length === 0 ? (
        <p className="text-sm text-[#52525b]">
          {tab === "open" ? "No open positions" : tab === "idle" ? "No idle accounts" : "No accounts"}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase text-[#52525b]">
                <SortHeader label="#" sKey="idx" align="left" />
                <SortHeader label="Owner" sKey="owner" align="left" />
                {isOpenLike && <SortHeader label="Direction" sKey="direction" align="left" />}
                {isOpenLike && <SortHeader label="Position" sKey="position" />}
                {isOpenLike && <SortHeader label="Entry" sKey="entry" />}
                {isOpenLike && <SortHeader label="Liq Price" sKey="liqPrice" />}
                {isOpenLike && <SortHeader label="Cost" sKey="cost" />}
                <SortHeader label="PnL" sKey="pnl" />
                <SortHeader label="Capital" sKey="capital" />
                {isOpenLike && <SortHeader label="Margin" sKey="margin" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e1e2e]/50">
              {sortedRows.map((row, i) => {
                const absPos = row.positionSize < 0n ? -row.positionSize : row.positionSize;
                return (
                  <tr key={row.idx} className="hover:bg-[#1a1a2e]/50">
                    <td className="py-1.5 text-[#52525b]">{i + 1}</td>
                    <td className="py-1.5 font-mono text-[#71717a]">{shortenAddress(row.owner)}</td>
                    {isOpenLike && (
                      <td className="py-1.5">
                        {row.direction === "IDLE" ? (
                          <span className="text-[#52525b]">-</span>
                        ) : (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            row.direction === "LONG"
                              ? "bg-emerald-900/40 text-emerald-400"
                              : "bg-red-900/40 text-red-400"
                          }`}>
                            {row.direction}
                          </span>
                        )}
                      </td>
                    )}
                    {isOpenLike && (
                      <td className={`py-1.5 text-right font-mono ${
                        row.positionSize > 0n ? "text-emerald-400" : row.positionSize < 0n ? "text-red-400" : "text-[#52525b]"
                      }`}>
                        {row.positionSize !== 0n ? formatTokenAmount(absPos) : "-"}
                      </td>
                    )}
                    {isOpenLike && (
                      <td className="py-1.5 text-right font-mono text-[#e4e4e7]">
                        {row.entryPrice > 0n ? formatUsd(row.entryPrice) : "-"}
                      </td>
                    )}
                    {isOpenLike && (
                      <td className="py-1.5 text-right">
                        {row.positionSize !== 0n ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <span className="font-mono text-[#e4e4e7]">{formatUsd(row.liqPrice)}</span>
                            <div className="h-1.5 w-10 rounded-full bg-[#1a1a2e]">
                              <div
                                className={`h-1.5 rounded-full ${liqBarColor(row.liqHealthPct)}`}
                                style={{ width: `${Math.max(4, row.liqHealthPct)}%` }}
                              />
                            </div>
                          </div>
                        ) : "-"}
                      </td>
                    )}
                    {isOpenLike && (
                      <td className="py-1.5 text-right font-mono text-[#a1a1aa]">
                        {row.cost > 0n ? formatTokenAmount(row.cost) : "-"}
                      </td>
                    )}
                    <td className={`py-1.5 text-right font-mono ${
                      row.pnl > 0n ? "text-emerald-400" : row.pnl < 0n ? "text-red-400" : "text-[#52525b]"
                    }`}>
                      {formatPnl(row.pnl)}
                    </td>
                    <td className="py-1.5 text-right font-mono text-[#e4e4e7]">
                      {formatTokenAmount(row.capital)}
                    </td>
                    {isOpenLike && (
                      <td className={`py-1.5 text-right font-mono ${
                        row.marginPct > 50 ? "text-emerald-400"
                          : row.marginPct > 20 ? "text-yellow-400"
                          : "text-red-400"
                      }`}>
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
