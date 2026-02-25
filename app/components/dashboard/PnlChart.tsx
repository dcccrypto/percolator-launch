"use client";

import { useState, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { getMockPnlHistory, type PnlDataPoint } from "@/lib/mock-dashboard-data";

type TimeRange = "24h" | "7d" | "30d" | "all";

function formatTime(ts: number, range: TimeRange): string {
  const d = new Date(ts);
  if (range === "24h") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (range === "7d") return d.toLocaleDateString([], { weekday: "short", hour: "2-digit" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatUsd(val: number): string {
  const sign = val >= 0 ? "+" : "";
  return `${sign}$${Math.abs(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: PnlDataPoint }>;
  range: TimeRange;
}

function ChartTooltip({ active, payload, range }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const data = payload[0].payload;
  const d = new Date(data.timestamp);
  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--bg)]/95 px-3 py-2 text-xs backdrop-blur-md">
      <p className="text-[var(--text-secondary)]">
        {d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}{" "}
        {d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </p>
      <p
        className={`mt-1 text-sm font-bold ${data.cumulativePnl >= 0 ? "text-[var(--long)]" : "text-[var(--short)]"}`}
        style={{ fontFamily: "var(--font-jetbrains-mono)" }}
      >
        {formatUsd(data.cumulativePnl)}
      </p>
      {data.tradeEvent && (
        <p className="mt-0.5 text-[10px] text-[var(--accent)]">📊 {data.tradeEvent}</p>
      )}
    </div>
  );
}

export function PnlChart() {
  const [range, setRange] = useState<TimeRange>("7d");
  const data = useMemo(() => getMockPnlHistory(range), [range]);

  const lastPnl = data[data.length - 1]?.cumulativePnl ?? 0;
  const firstPnl = data[0]?.cumulativePnl ?? 0;
  const changePct = firstPnl !== 0 ? ((lastPnl - firstPnl) / Math.abs(firstPnl)) * 100 : lastPnl > 0 ? 100 : lastPnl < 0 ? -100 : 0;
  const isPositive = lastPnl >= 0;

  const ranges: TimeRange[] = ["24h", "7d", "30d", "all"];

  return (
    <div className="flex h-full flex-col border border-[var(--border)] bg-[var(--panel-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <div>
          <p className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
            Portfolio PnL
          </p>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={`text-xl font-bold ${isPositive ? "text-[var(--long)]" : "text-[var(--short)]"}`}
              style={{ fontFamily: "var(--font-jetbrains-mono)" }}
            >
              {formatUsd(lastPnl)}
            </span>
            <span
              className={`text-xs font-medium ${isPositive ? "text-[var(--long)]/70" : "text-[var(--short)]/70"}`}
            >
              {changePct >= 0 ? "↑" : "↓"} {Math.abs(changePct).toFixed(1)}%
            </span>
          </div>
        </div>

        {/* Time range controls */}
        <div className="flex items-center gap-0.5 rounded-sm border border-[var(--border)] bg-[var(--bg)] p-0.5">
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={[
                "px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-sm transition-all duration-200",
                range === r
                  ? "bg-[var(--accent)]/15 text-[var(--accent)] shadow-[0_0_12px_rgba(153,69,255,0.2)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]",
              ].join(" ")}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 px-2 py-2" style={{ minHeight: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
            <defs>
              <linearGradient id="pnlGradientPos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#14F195" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#14F195" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="pnlGradientNeg" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FF3B5C" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#FF3B5C" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="timestamp"
              tickFormatter={(ts) => formatTime(ts, range)}
              stroke="rgba(255,255,255,0.1)"
              tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10, fontFamily: "var(--font-jetbrains-mono)" }}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
            <YAxis
              orientation="right"
              tickFormatter={(v) => `$${Math.abs(v).toLocaleString()}`}
              stroke="rgba(255,255,255,0.1)"
              tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 10, fontFamily: "var(--font-jetbrains-mono)" }}
              tickLine={false}
              axisLine={false}
              width={70}
            />
            <ReferenceLine
              y={0}
              stroke="rgba(255,255,255,0.15)"
              strokeDasharray="4 4"
            />
            <Tooltip content={<ChartTooltip range={range} />} />
            <Area
              type="monotone"
              dataKey="cumulativePnl"
              stroke={isPositive ? "#14F195" : "#FF3B5C"}
              strokeWidth={2}
              fill={isPositive ? "url(#pnlGradientPos)" : "url(#pnlGradientNeg)"}
              animationDuration={400}
              animationEasing="ease-in-out"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
