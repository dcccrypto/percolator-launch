"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useWalletCompat } from "@/hooks/useWalletCompat";

/* ── Constants ────────────────────────────────────────────── */
/** S2 devnet trading competition end: March 21, 2026 00:00 UTC */
const COMPETITION_END = new Date("2026-03-21T00:00:00Z");

/** True when deployed against mainnet-beta (GH#1572, GH#1573) */
const IS_MAINNET =
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() === "mainnet-beta" ||
  process.env.NEXT_PUBLIC_DEFAULT_NETWORK?.trim() === "mainnet" ||
  process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim() === "mainnet-beta" ||
  process.env.NEXT_PUBLIC_SOLANA_NETWORK?.trim() === "mainnet";

/* ── Types ────────────────────────────────────────────────── */
interface LeaderboardEntry {
  rank: number;
  trader: string;
  tradeCount: number;
  totalVolume: string;
  lastTradeAt: string;
}

type Period = "24h" | "7d" | "alltime";

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  ended: boolean;
}

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

function getTimeLeft(): TimeLeft {
  const now = Date.now();
  const diff = COMPETITION_END.getTime() - now;
  if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, ended: true };
  const totalSec = Math.floor(diff / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return { days, hours, minutes, seconds, ended: false };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Hook to determine the collateral decimals for the current network by fetching
 * the markets list and finding the modal (most common) decimal value.
 *
 * GH#1833: Previously this was a hardcoded per-network constant — mainnet=6 (USDC),
 * devnet=9 (PERC token). That breaks multi-collateral markets. This hook fetches
 * actual market data so the displayed divisor matches reality.
 *
 * Falls back to the old IS_MAINNET heuristic if the API call fails.
 */
function useCollateralDecimals(): number {
  const fallback = IS_MAINNET ? 6 : 9;
  const [decimals, setDecimals] = useState<number>(fallback);

  useEffect(() => {
    fetch("/api/markets?limit=200")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.markets?.length) return;
        // Find the modal (most-common) decimal value across all active markets
        const freq: Record<number, number> = {};
        for (const m of data.markets) {
          if (typeof m.decimals === "number" && m.decimals > 0) {
            freq[m.decimals] = (freq[m.decimals] ?? 0) + 1;
          }
        }
        const entries = Object.entries(freq);
        if (entries.length === 0) return;
        const modal = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
        setDecimals(Number(modal[0]));
      })
      .catch(() => {/* keep fallback */});
  }, []);

  return decimals;
}

/** Default divisor fallback used by fmtVolume when no divisor is provided. */
const DEFAULT_DIVISOR = IS_MAINNET ? 1_000_000 : 1_000_000_000;

/** Format raw bigint volume as a compact human-readable string.
 * @param raw - raw token amount as string (sum of abs(size) from on-chain trades)
 * @param divisor - 10^decimals for the collateral token (default: network-based heuristic)
 */
function fmtVolume(raw: string, divisor = DEFAULT_DIVISOR): string {
  try {
    const n = BigInt(raw);
    // Divide by 10^decimals to convert raw token units to human-readable amount
    const units = Number(n) / divisor;
    if (units >= 1_000_000_000) return `${(units / 1_000_000_000).toFixed(2)}B`;
    if (units >= 1_000_000) return `${(units / 1_000_000).toFixed(2)}M`;
    if (units >= 1_000) return `${(units / 1_000).toFixed(1)}K`;
    return units.toLocaleString(undefined, { maximumFractionDigits: units < 1 ? 6 : 2 });
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

/* ── CompetitionBanner ────────────────────────────────────── */
function CompetitionBanner() {
  const [timeLeft, setTimeLeft] = useState<TimeLeft>(() => getTimeLeft());

  useEffect(() => {
    const id = setInterval(() => setTimeLeft(getTimeLeft()), 1000);
    return () => clearInterval(id);
  }, []);

  if (timeLeft.ended) {
    return (
      <div
        className="mb-6 px-5 py-4 border font-mono text-center text-sm"
        style={{
          background: "rgba(153,69,255,0.06)",
          borderColor: "rgba(153,69,255,0.25)",
          color: "var(--text-secondary)",
        }}
      >
        <span className="text-xs uppercase tracking-widest" style={{ color: "var(--accent)" }}>
          S2 Devnet Competition
        </span>
        <span className="ml-3" style={{ color: "var(--text-muted)" }}>
          Competition ended — results are final.
        </span>
      </div>
    );
  }

  return (
    <div
      className="mb-6 border"
      style={{
        background: "rgba(153,69,255,0.06)",
        borderColor: "rgba(153,69,255,0.2)",
      }}
    >
      {/* Top strip */}
      <div
        className="flex items-center justify-between px-5 py-2 border-b"
        style={{ borderColor: "rgba(153,69,255,0.15)" }}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] font-bold uppercase tracking-[0.2em] px-1.5 py-0.5 rounded-sm"
            style={{ background: "var(--accent)", color: "#fff" }}
          >
            LIVE
          </span>
          <span
            className="text-xs font-mono font-semibold uppercase tracking-widest"
            style={{ color: "var(--text)" }}
          >
            S2 Devnet Trading Competition
          </span>
        </div>
        <span className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
          Ends Mar 21, 2026
        </span>
      </div>

      {/* Body */}
      <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        {/* Prizes */}
        <div className="flex items-start gap-6">
          <div>
            <p
              className="text-[10px] font-mono uppercase tracking-[0.18em] mb-1"
              style={{ color: "var(--text-muted)" }}
            >
              #1 Prize
            </p>
            <p className="text-sm font-bold tabular-nums" style={{ color: "var(--text)" }}>
              🥇 Early Access
            </p>
            <p className="text-[11px] font-mono mt-0.5" style={{ color: "var(--text-secondary)" }}>
              Beta whitelist spot
            </p>
          </div>
          <div>
            <p
              className="text-[10px] font-mono uppercase tracking-[0.18em] mb-1"
              style={{ color: "var(--text-muted)" }}
            >
              Top 10
            </p>
            <p className="text-sm font-bold tabular-nums" style={{ color: "var(--text)" }}>
              🎖️ Beta Badge
            </p>
            <p className="text-[11px] font-mono mt-0.5" style={{ color: "var(--text-secondary)" }}>
              Pioneer role on Discord
            </p>
          </div>
          <div>
            <p
              className="text-[10px] font-mono uppercase tracking-[0.18em] mb-1"
              style={{ color: "var(--text-muted)" }}
            >
              Ranked
            </p>
            <p className="text-sm font-bold tabular-nums" style={{ color: "var(--text)" }}>
              📊 On-Chain Record
            </p>
            <p className="text-[11px] font-mono mt-0.5" style={{ color: "var(--text-secondary)" }}>
              Volume logged forever
            </p>
          </div>
        </div>

        {/* Countdown */}
        <div
          className="shrink-0 flex gap-3 items-end"
          aria-label="Time remaining in competition"
        >
          {[
            { value: timeLeft.days, label: "DAYS" },
            { value: timeLeft.hours, label: "HRS" },
            { value: timeLeft.minutes, label: "MIN" },
            { value: timeLeft.seconds, label: "SEC" },
          ].map(({ value, label }, i) => (
            <div key={label} className="flex items-center gap-3">
              {i > 0 && (
                <span
                  className="text-lg font-mono font-bold mb-3"
                  style={{ color: "rgba(153,69,255,0.5)" }}
                >
                  :
                </span>
              )}
              <div className="flex flex-col items-center">
                <span
                  className="text-2xl font-bold font-mono tabular-nums"
                  style={{ color: "var(--accent)", lineHeight: 1.1 }}
                >
                  {pad(value)}
                </span>
                <span
                  className="text-[8px] font-mono uppercase tracking-[0.15em] mt-0.5"
                  style={{ color: "var(--text-muted)" }}
                >
                  {label}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Share helpers ────────────────────────────────────────── */
const LEADERBOARD_URL = "https://percolatorlaunch.com/leaderboard";

function buildShareText(entry: LeaderboardEntry, divisor = DEFAULT_DIVISOR): string {
  const medal = RANK_MEDALS[entry.rank];
  const rankStr = medal ? `${medal} #${entry.rank}` : `#${entry.rank}`;
  const vol = fmtVolume(entry.totalVolume, divisor);
  const network = IS_MAINNET ? "mainnet" : "devnet";
  return (
    `I'm ${rankStr} on the @percolatorlaunch ${network} leaderboard with ${vol} volume!\n\n` +
    `Permissionless perps on Solana — join the beta 🚀\n\n` +
    LEADERBOARD_URL
  );
}

function buildGenericShareText(): string {
  const network = IS_MAINNET ? "mainnet" : "devnet";
  return (
    `Check out the @percolatorlaunch ${network} trading leaderboard!\n\n` +
    `Permissionless perps on Solana — join the beta 🚀\n\n` +
    LEADERBOARD_URL
  );
}

function twitterUrl(text: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

/* ── MyRankCard ───────────────────────────────────────────── */
interface MyRankCardProps {
  entry: LeaderboardEntry | null;
  walletConnected: boolean;
}

function MyRankCard({ entry, walletConnected, divisor = DEFAULT_DIVISOR }: MyRankCardProps & { divisor?: number }) {
  const [copied, setCopied] = useState(false);

  const handleShare = useCallback(() => {
    const text = entry ? buildShareText(entry, divisor) : buildGenericShareText();
    window.open(twitterUrl(text), "_blank", "noopener,noreferrer");
  }, [entry, divisor]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(LEADERBOARD_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* silently fail */
    }
  }, []);

  // Show nothing if wallet not connected and no entry
  if (!walletConnected && !entry) return null;

  if (!entry) {
    // Connected but not ranked — show generic share
    return (
      <div
        className="mb-6 px-4 py-3 border flex items-center justify-between gap-4"
        style={{
          background: "var(--panel-bg)",
          borderColor: "var(--border)",
        }}
      >
        <p className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
          Not ranked yet — start trading to appear on the board
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleShare}
            className="px-3 py-1.5 text-xs font-mono tracking-wide transition-all"
            style={{
              background: "transparent",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
            }}
          >
            SHARE 𝕏
          </button>
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 text-xs font-mono transition-all"
            style={{
              background: "transparent",
              color: copied ? "var(--accent)" : "var(--text-muted)",
              border: "1px solid var(--border)",
            }}
          >
            {copied ? "COPIED!" : "COPY LINK"}
          </button>
        </div>
      </div>
    );
  }

  const medal = RANK_MEDALS[entry.rank];

  return (
    <div
      className="mb-6 px-4 py-4 border"
      style={{
        background: "rgba(153,69,255,0.06)",
        borderColor: "rgba(153,69,255,0.3)",
      }}
    >
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* Rank info */}
        <div>
          <p
            className="text-[10px] font-mono uppercase tracking-[0.18em] mb-1.5"
            style={{ color: "var(--text-muted)" }}
          >
            Your Rank
          </p>
          <div className="flex items-center gap-3">
            <span
              className="text-2xl leading-none"
              aria-label={medal ? `Rank ${entry.rank}` : undefined}
            >
              {medal ?? (
                <span
                  className="text-xl font-bold tabular-nums"
                  style={{ color: "var(--accent)" }}
                >
                  #{entry.rank}
                </span>
              )}
            </span>
            {medal && (
              <span
                className="text-lg font-bold tabular-nums"
                style={{ color: "var(--accent)" }}
              >
                #{entry.rank}
              </span>
            )}
            <div className="text-xs font-mono" style={{ color: "var(--text-secondary)" }}>
              <span className="tabular-nums">{entry.tradeCount.toLocaleString()} trades</span>
              <span className="mx-2" style={{ color: "var(--text-muted)" }}>·</span>
              <span className="tabular-nums">{fmtVolume(entry.totalVolume, divisor)} vol</span>
            </div>
          </div>
        </div>

        {/* Share buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleShare}
            className="px-4 py-1.5 text-xs font-mono font-semibold tracking-wide transition-all hover:opacity-90"
            style={{
              background: "var(--accent)",
              color: "#fff",
              border: "1px solid var(--accent)",
            }}
            title="Share your rank on X / Twitter"
          >
            SHARE 𝕏
          </button>
          <button
            onClick={handleCopy}
            className="px-3 py-1.5 text-xs font-mono transition-all"
            style={{
              background: "var(--panel-bg)",
              color: copied ? "var(--accent)" : "var(--text-secondary)",
              border: "1px solid var(--border)",
            }}
            title="Copy leaderboard link"
          >
            {copied ? "✓ COPIED" : "COPY LINK"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Main Component ───────────────────────────────────────── */
export default function LeaderboardPage() {
  const [period, setPeriod] = useState<Period>("24h");
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  const { publicKey, connected } = useWalletCompat();
  // GH#1833: use per-network market decimals instead of hardcoded constant
  const collateralDecimals = useCollateralDecimals();
  const divisor = useMemo(() => Math.pow(10, collateralDecimals), [collateralDecimals]);

  const fetchLeaderboard = useCallback(async (p: Period) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/leaderboard?period=${p}&limit=100`);
      if (!res.ok) {
        if (res.status === 429) {
          throw new Error("Leaderboard is temporarily unavailable — too many requests. Try again in a moment.");
        }
        if (res.status >= 500) {
          throw new Error("Leaderboard service is temporarily down. Please try again shortly.");
        }
        throw new Error("Failed to load leaderboard. Please try again.");
      }
      const json = await res.json();
      setEntries(json.leaderboard ?? []);
      setGeneratedAt(json.generatedAt ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load leaderboard. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = "Leaderboard — Percolator";
    fetchLeaderboard(period);
  }, [period, fetchLeaderboard]);

  const noData = !loading && !error && entries.length === 0;

  /** Find connected wallet in the current leaderboard entries */
  const myEntry = publicKey
    ? entries.find(
        (e) => e.trader.toLowerCase() === publicKey.toBase58().toLowerCase()
      ) ?? null
    : null;

  return (
    <main className="min-h-screen pt-20 pb-24">
      <div className="max-w-3xl mx-auto px-4 sm:px-6">

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-1">
            <span className="text-2xl">🏆</span>
            <h1
              className="text-3xl font-bold tracking-tight"
              style={{ fontFamily: "var(--font-display)", color: "var(--text)" }}
            >
              Leaderboard
            </h1>
            {/* Network badge: hidden on mainnet (GH#1572) */}
            {!IS_MAINNET && (
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
            )}
          </div>
          <p style={{ color: "var(--text-secondary)" }} className="text-sm font-mono">
            {IS_MAINNET
              ? "Top traders by volume on Percolator (trade count as tiebreaker)"
              : "Top traders by trade volume on the Percolator devnet (trade count as tiebreaker)"}
          </p>
        </div>

        {/* ── Competition Banner ──────────────────────────────────── */}
        {/* S2 devnet competition banner: only shown on devnet (GH#1572) */}
        {!IS_MAINNET && <CompetitionBanner />}

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

        {/* ── My Rank / Share ─────────────────────────────────────── */}
        {!loading && (
          <MyRankCard entry={myEntry} walletConnected={connected} divisor={divisor} />
        )}

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
                    {fmtVolume(entry.totalVolume, divisor)}
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
            className="mt-8 px-6 py-5 border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4"
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
                {IS_MAINNET
                  ? "Start trading permissionless perps across 126+ markets."
                  : "Get free devnet tokens and start trading across 126+ markets."}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* Generic share for unranked / not-connected visitors */}
              {!myEntry && (
                <button
                  onClick={() =>
                    window.open(
                      twitterUrl(buildGenericShareText()),
                      "_blank",
                      "noopener,noreferrer"
                    )
                  }
                  className="px-4 py-2 text-xs font-mono tracking-wide transition-all hover:opacity-80"
                  style={{
                    background: "transparent",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border)",
                  }}
                >
                  SHARE 𝕏
                </button>
              )}
              {/* On mainnet link to trade; on devnet link to faucet (GH#1572) */}
              <Link
                href={IS_MAINNET ? "/trade" : "/devnet-mint"}
                className="shrink-0 px-4 py-2 text-xs font-mono font-semibold tracking-wide transition-all"
                style={{
                  background: "var(--accent)",
                  color: "#fff",
                  border: "1px solid var(--accent)",
                }}
              >
                {IS_MAINNET ? "TRADE NOW →" : "GET TOKENS →"}
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
