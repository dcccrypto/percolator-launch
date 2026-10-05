"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { CapacityChart, type ChartSeries } from "@/components/v21/CapacityChart";
import { sideLabel, type CapacityPoint } from "@/lib/v21/capacity-snapshots";

interface MarketRow extends CapacityPoint {
  symbol: string | null;
}

const fetchJson = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
};

const usdFmt = (v: number): string =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${(v / 1_000).toFixed(1)}k` : `$${v.toFixed(0)}`;
const pctFmt = (v: number | null): string => (v === null ? "-" : `${Math.round(v * 100)}%`);
const shortAddr = (s: string): string => `${s.slice(0, 4)}...${s.slice(-4)}`;

const RANGES: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 6, label: "6h" },
  { hours: 24, label: "24h" },
  { hours: 24 * 7, label: "7d" },
];

/**
 * /growth (Devnet v2.1): per-market capacity table plus capacity-over-time charts. Mounted only when
 * NEXT_PUBLIC_DEVNET_V21 is on (the page 404s otherwise), so no fetch is ever made with the flag off.
 */
export function GrowthDashboard() {
  const { data, error, isLoading } = useSWR<{ markets: MarketRow[] }>("/api/v21/capacity", fetchJson, { refreshInterval: 60_000 });
  const [picked, setPicked] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const markets = useMemo(() => [...(data?.markets ?? [])].sort((a, b) => (b.capacityUsd ?? 0) - (a.capacityUsd ?? 0)), [data]);
  const slab = picked ?? markets[0]?.slab ?? null;
  const series = useSWR<{ points: CapacityPoint[] }>(slab ? `/api/v21/capacity?slab=${slab}&hours=${hours}` : null, fetchJson, { refreshInterval: 60_000 });

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-8 lg:px-6">
      <h1 className="text-2xl font-semibold text-[var(--text)]">Growth</h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm text-[var(--text-secondary)]">
        How much each market can carry, how full each side is, and the leverage it allows right now. Capacity follows the capital behind the market, so it rises as junior and Earn capital grows.
      </p>

      {error ? (
        <p role="alert" className="rounded-lg border border-[var(--border)] p-4 text-sm text-[var(--text-secondary)]">
          Capacity data is unavailable right now.
        </p>
      ) : isLoading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading...</p>
      ) : markets.length === 0 ? (
        <p className="rounded-lg border border-[var(--border)] p-4 text-sm text-[var(--text-secondary)]" data-testid="growth-empty">
          No growth markets have reported yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]">
          <table className="w-full min-w-[820px] text-left text-sm" data-testid="growth-table">
            <thead className="text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
              <tr>
                {["Market", "Capacity", "Long used", "Short used", "Max lev long", "Max lev short", "Earn NAV", "NAV/share", "Allocated"].map((h) => (
                  <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {markets.map((m) => (
                <tr key={m.slab} className={m.slab === slab ? "bg-[var(--accent-subtle)]" : undefined}>
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => setPicked(m.slab)} className="font-medium text-[var(--accent-text)] hover:underline" aria-pressed={m.slab === slab}>
                      {m.symbol ?? shortAddr(m.slab)}
                    </button>
                    {m.adlActive || m.hlockActive ? <span className="ml-2 text-[11px] text-[var(--short)]">{m.hlockActive ? "locked" : "wind-down"}</span> : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{m.capacityUsd === null ? "-" : usdFmt(m.capacityUsd)}</td>
                  <td className="px-3 py-2 tabular-nums">{pctFmt(m.utilLong)}</td>
                  <td className="px-3 py-2 tabular-nums">{pctFmt(m.utilShort)}</td>
                  <td className="px-3 py-2 tabular-nums">{sideLabel(m.maxLevLong, m.longClosed)}</td>
                  <td className="px-3 py-2 tabular-nums">{sideLabel(m.maxLevShort, m.shortClosed)}</td>
                  <td className="px-3 py-2 tabular-nums">{m.earnNavUsd === null ? "-" : usdFmt(m.earnNavUsd)}</td>
                  <td className="px-3 py-2 tabular-nums">{m.navPerShare === null ? "-" : m.navPerShare.toFixed(4)}</td>
                  <td className="px-3 py-2 tabular-nums">{m.allocatedUsd === null ? "-" : usdFmt(m.allocatedUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {slab ? (
        <section className="mt-8" aria-label="Capacity over time">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-lg font-semibold text-[var(--text)]">Over time</h2>
            <div className="ml-auto flex gap-1" role="group" aria-label="Range">
              {RANGES.map((r) => (
                <button key={r.hours} type="button" onClick={() => setHours(r.hours)} aria-pressed={hours === r.hours} className={`rounded-md border px-2.5 py-1 text-xs ${hours === r.hours ? "border-[var(--accent)] text-[var(--accent-text)]" : "border-[var(--border)] text-[var(--text-secondary)]"}`}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {charts(series.data?.points ?? []).map((c) => (
              <CapacityChart key={c.title} {...c} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

const pts = (ps: ReadonlyArray<CapacityPoint>, f: (p: CapacityPoint) => number | null): Array<readonly [number, number | null]> => ps.map((p) => [p.t, f(p)] as const);

/** The four charts of one market (pure; exported for tests). */
export function charts(ps: ReadonlyArray<CapacityPoint>): Array<{ title: string; series: ChartSeries[]; format: (v: number) => string; zeroBased?: boolean }> {
  return [
    {
      title: "Capacity",
      format: usdFmt,
      series: [
        { key: "cap", label: "Capacity", color: "var(--accent-text)", points: pts(ps, (p) => p.capacityUsd) },
        { key: "lp", label: "LP capital", color: "var(--long)", points: pts(ps, (p) => p.lpEquityUsd) },
        { key: "nav", label: "Earn NAV", color: "var(--text-secondary)", dashed: true, points: pts(ps, (p) => p.earnNavUsd) },
        { key: "alloc", label: "Allocated", color: "var(--short)", dashed: true, points: pts(ps, (p) => p.allocatedUsd) },
      ],
    },
    {
      title: "Used capacity",
      format: (v) => `${Math.round(v * 100)}%`,
      series: [
        { key: "ul", label: "Long", color: "var(--long)", points: pts(ps, (p) => p.utilLong) },
        { key: "us", label: "Short", color: "var(--short)", points: pts(ps, (p) => p.utilShort) },
      ],
    },
    {
      title: "Max leverage",
      format: (v) => `${v.toFixed(0)}x`,
      series: [
        { key: "ml", label: "Long", color: "var(--long)", points: pts(ps, (p) => p.maxLevLong) },
        { key: "ms", label: "Short", color: "var(--short)", points: pts(ps, (p) => p.maxLevShort) },
        { key: "mc", label: "Ceiling", color: "var(--text-muted)", dashed: true, points: pts(ps, (p) => p.ceilLev) },
      ],
    },
    {
      title: "Earn NAV per share",
      format: (v) => v.toFixed(3),
      zeroBased: false,
      series: [{ key: "nps", label: "NAV/share", color: "var(--accent-text)", points: pts(ps, (p) => p.navPerShare) }],
    },
  ];
}
