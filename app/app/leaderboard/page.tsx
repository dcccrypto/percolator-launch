"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

/* ── Types ────────────────────────────────────────────────── */
interface LeaderboardEntry {
  rank: number;
  trader: string;
  tradeCount: number;
  totalVolume: string;
  lastTradeAt: string;
}

type Period = "24h" | "7d" | "alltime";

/* ── Helpers ──────────────────────────────────────────────── */
function shortenAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function timeSince(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Format raw bigint volume as a compact human-readable string */
/** Micro-unit divisor: 6 decimal places used for all devnet collateral tokens */
const MICRO_UNIT_DIVISOR = 1_000_000;

function fmtVolume(raw: string): string {
  try {
    const n = BigInt(raw);
    // Display in "units" (divide by MICRO_UNIT_DIVISOR for micro-units used on devnet)
    const units = Number(n) / MICRO_UNIT_DIVISOR;
    if (units >= 1_000_000_000) return `${(units / 1_000_000_000).toFixed(2)}B`;
    if (units >= 1_000_000) return `${(units / 1_000_000).toFixed(2)}M`;
    if (units >= 1_000) return `${(units / 1_000).toFixed(1)}K`;
    if (units < 1 && n > 0n) {
      // Raw units might not need division — show raw with compact suffix
      const rawN = Number(n);
      if (rawN >= 1_000_000_000) return `${(rawN / 1_000_000_000).toFixed(2)}B`;
      if (rawN >= 1_000_000) return `${(rawN / 1_000_000).toFixed(2)}M`;
      if (rawN >= 1_000) return `${(rawN / 1_000).toFixed(1)}K`;
      return rawN.toLocaleString();
    }
    return units.toLocaleString(undefined, { maximumFractionDigits: 2 });
  } catch {
    return "—";
  }
}

const RANK_MEDALS: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

const PERIOD_LABELS: Record<Period, string> = {
  "24h": "24 Hours",
  "7d": "7 Days",
  alltime: "All-Time",
};

/* ── Main Component ───────────────────────────────────────── */
export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>("24h");
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const fetchLeaderboard = useCallback(async (p: Period) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/leaderboard?period=${p}&limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setEntries(json.leaderboard ?? []);
      setGeneratedAt(json.generatedAt ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load leaderboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Leaderboard — Percolator";
    fetchLeaderboard(period);
  }, [period, fetchLeaderboard]);

  const noData = !loading && !error && entries.length === 0;

  return (
    <main className="min-h-screen pt-20 pb-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6">

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-1">
            <span className="text-2xl">🏆</span>
            <h1
              className="text-3xl font-bold tracking-tight"
              style={{ fontFamily: "var(--font-display)", color: "var(--text)" }}
            >
              Leaderboard
            </h1>
            <span
              className="text-xs font-mono px-2 py-0.5 rounded-sm border"
              style={{
                color: "var(--accent)",
                borderColor: "var(--accent)",
                background: "rgba(153,69,255,0.07)",
              }}
            >
              DEVNET
            </span>
          </div>
          <p style={{ color: "var(--text-secondary)" }} className="text-sm font-mono">
            Top traders by trade volume on the Percolator devnet (trade count as tiebreaker)
          </p>
        </div>

        {/* ── Period Switcher ─────────────────────────────────────── */}
        <div className="flex gap-1 mb-6">
          {(["24h", "7d", "alltime"] as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className="px-4 py-1.5 text-xs font-mono tracking-wider transition-all"
              style={
                period === p
                  ? {
                      background: "var(--accent)",
                      color: "#fff",
                      border: "1px solid var(--accent)",
                    }
                  : {
                      background: "var(--panel-bg)",
                      color: "var(--text-secondary)",
                      border: "1px solid var(--border)",
                    }
              }
            >
              {PERIOD_LABELS[p].toUpperCase()}
            </button>
          ))}
          <button
            onClick={() => fetchLeaderboard(period)}
            className="ml-auto px-3 py-1.5 text-xs font-mono transition-all"
            title="Refresh"
            style={{
              background: "var(--panel-bg)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
            }}
          >
            ↻
          </button>
        </div>

        {/* ── Loading skeleton ────────────────────────────────────── */}
        {loading && (
          <div className="space-y-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-14 animate-pulse border"
                style={{
                  background: "var(--panel-bg)",
                  borderColor: "var(--border)",
                  opacity: 1 - i * 0.08,
                }}
              />
            ))}
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────────── */}
        {error && !loading && (
          <div
            className="px-4 py-6 text-center font-mono text-sm border"
            style={{
              background: "rgba(239,68,68,0.06)",
              borderColor: "rgba(239,68,68,0.3)",
              color: "#f87171",
            }}
          >
            {error}
          </div>
        )}

        {/* ── Empty state ─────────────────────────────────────────── */}
        {noData && (
          <div
            className="px-4 py-12 text-center font-mono text-sm border"
            style={{
              background: "var(--panel-bg)",
              borderColor: "var(--border)",
              color: "var(--text-muted)",
            }}
          >
            No trades found for this period.
            <br />
            <Link
              href="/trade"
              className="mt-2 inline-block underline"
              style={{ color: "var(--accent)" }}
            >
              Start trading →
            </Link>
          </div>
        )}

        {/* ── Table ───────────────────────────────────────────────── */}
        {!loading && !error && entries.length > 0 && (
          <div className="space-y-px">
            {/* Header row */}
            <div
              className="grid text-xs font-mono tracking-widest uppercase px-4 py-2"
              style={{
                gridTemplateColumns: "3rem 1fr 6rem 6rem 6rem",
                color: "var(--text-muted)",
                background: "var(--panel-bg)",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span>#</span>
              <span>Trader</span>
              <span className="text-right">Trades</span>
              <span className="text-right">Volume</span>
              <span className="text-right hidden sm:block">Last Active</span>
            </div>

            {/* Data rows */}
            {entries.map((entry) => {
              const isTop3 = entry.rank <= 3;
              const medal = RANK_MEDALS[entry.rank];
              return (
                <div
                  key={entry.trader}
                  className={`grid items-center px-4 py-3 font-mono text-sm transition-colors border ${
                    isTop3
                      ? "border-[rgba(153,69,255,0.2)] hover:border-[rgba(153,69,255,0.35)]"
                      : "border-[var(--border)] hover:border-[var(--border-hover)]"
                  }`}
                  style={{
                    gridTemplateColumns: "3rem 1fr 6rem 6rem 6rem",
                    background: isTop3
                      ? "rgba(153,69,255,0.04)"
                      : "var(--panel-bg)",
                    color: "var(--text)",
                  }}
                >
                  {/* Rank */}
                  <span
                    className="text-sm"
                    style={{ color: isTop3 ? "var(--accent)" : "var(--text-muted)" }}
                  >
                    {medal ?? entry.rank}
                  </span>

                  {/* Trader address */}
                  <span
                    className="truncate"
                    style={{ color: isTop3 ? "var(--text)" : "var(--text-secondary)" }}
                    title={entry.trader}
                  >
                    {shortenAddr(entry.trader)}
                  </span>

                  {/* Trade count */}
                  <span
                    className="text-right tabular-nums"
                    style={{ color: "var(--text)" }}
                  >
                    {entry.tradeCount.toLocaleString()}
                  </span>

                  {/* Volume */}
                  <span
                    className="text-right tabular-nums"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {fmtVolume(entry.totalVolume)}
                  </span>

                  {/* Last active */}
                  <span
                    className="text-right hidden sm:block"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {timeSince(entry.lastTradeAt)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Footer ──────────────────────────────────────────────── */}
        <div
          className="mt-6 flex items-center justify-between text-xs font-mono"
          style={{ color: "var(--text-muted)" }}
        >
          <span>
            {entries.length > 0 ? `Showing top ${entries.length} traders` : ""}
          </span>
          {generatedAt && (
            <span>Updated {timeSince(generatedAt)}</span>
          )}
        </div>

        {/* ── CTA ─────────────────────────────────────────────────── */}
        {entries.length > 0 && (
          <div
            className="mt-8 px-6 py-5 border flex items-center justify-between gap-4"
            style={{
              background: "rgba(153,69,255,0.04)",
              borderColor: "rgba(153,69,255,0.2)",
            }}
          >
            <div>
              <p className="text-sm font-semibold mb-1" style={{ color: "var(--text)" }}>
                Want to climb the board?
              </p>
              <p className="text-xs font-mono" style={{ color: "var(--text-secondary)" }}>
                Get free devnet tokens and start trading across 126+ markets.
              </p>
            </div>
            <Link
              href="/devnet-mint"
              className="shrink-0 px-4 py-2 text-xs font-mono font-semibold tracking-wide transition-all"
              style={{
                background: "var(--accent)",
                color: "#fff",
                border: "1px solid var(--accent)",
              }}
            >
              GET TOKENS →
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
