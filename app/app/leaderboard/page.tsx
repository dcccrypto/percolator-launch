"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { ShimmerSkeleton } from "@/components/ui/ShimmerSkeleton";

/* ── Constants ────────────────────────────────────────────── */
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
 * @param raw - dollar-notional volume as string (sum of abs(size) * price across
 * trades, same scale/convention as trader-stats' totalVolume — NOT raw contract
 * quantity, so heterogeneous markets like SOL and sub-$1 tokens rank fairly)
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

const PERIOD_LABELS: Record<Period, string> = {
  "24h": "24H",
  "7d": "7D",
  alltime: "ALL-TIME",
};

/** Rank accent per podium slot — accent intensity instead of medal emoji.
 *  The site's palette has no gold/silver/bronze; a fading accent reads as
 *  hierarchy without breaking the terminal theme. */
function rankColor(rank: number): string {
  if (rank === 1) return "var(--accent)";
  if (rank === 2) return "var(--cyan)";
  if (rank === 3) return "var(--text)";
  return "var(--text-secondary)";
}

/* ── Share helpers ────────────────────────────────────────── */
/** Current deploy's leaderboard URL — never a hardcoded domain. */
function leaderboardUrl(): string {
  return `${window.location.origin}/leaderboard`;
}

function buildShareText(entry: LeaderboardEntry, divisor = DEFAULT_DIVISOR): string {
  const vol = fmtVolume(entry.totalVolume, divisor);
  const network = IS_MAINNET ? "mainnet" : "devnet";
  return (
    `I'm #${entry.rank} on the Percolator ${network} leaderboard with ${vol} volume.\n\n` +
    `Permissionless perps on Solana:\n${leaderboardUrl()}`
  );
}

function buildGenericShareText(): string {
  const network = IS_MAINNET ? "mainnet" : "devnet";
  return (
    `Percolator ${network} trading leaderboard — permissionless perps on Solana:\n${leaderboardUrl()}`
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
      await navigator.clipboard.writeText(leaderboardUrl());
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
      <div className="mb-6 flex items-center justify-between gap-4 border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-3">
        <p className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
          Not ranked yet — start trading to appear on the board
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={handleShare}
            className="border border-[var(--border)] bg-transparent px-3 py-1.5 text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
          >
            Share
          </button>
          <button
            onClick={handleCopy}
            className={`border border-[var(--border)] bg-transparent px-3 py-1.5 text-[10px] uppercase tracking-[0.12em] transition-colors hover:border-[var(--accent)]/30 ${copied ? "text-[var(--accent)]" : "text-[var(--text-secondary)] hover:text-[var(--text)]"}`}
          >
            {copied ? "Copied ✓" : "Copy Link"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6 border border-[var(--accent)]/30 bg-[var(--accent)]/[0.05] px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {/* Rank info */}
        <div>
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Your Rank
          </p>
          <div className="flex items-center gap-3">
            <span
              className="text-xl font-bold tabular-nums text-[var(--accent)]"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              #{entry.rank}
            </span>
            <div className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
              <span className="tabular-nums">{entry.tradeCount.toLocaleString()} trades</span>
              <span className="mx-2">·</span>
              <span className="tabular-nums">{fmtVolume(entry.totalVolume, divisor)} vol</span>
            </div>
          </div>
        </div>

        {/* Share buttons */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={handleShare}
            className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--accent)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15]"
            title="Share your rank on X"
          >
            Share on 𝕏
          </button>
          <button
            onClick={handleCopy}
            className={`border border-[var(--border)] bg-[var(--panel-bg)] px-3 py-1.5 text-[10px] uppercase tracking-[0.12em] transition-colors hover:border-[var(--accent)]/30 ${copied ? "text-[var(--accent)]" : "text-[var(--text-secondary)] hover:text-[var(--text)]"}`}
            title="Copy leaderboard link"
          >
            {copied ? "Copied ✓" : "Copy Link"}
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

  const prefersReduced = usePrefersReducedMotion();
  const rowsRef = useRef<HTMLDivElement | null>(null);

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

  // Staggered row entrance — same gsap-on-mount pattern the rest of the site
  // uses (ShareButton dropdown, ScrollReveal). Skipped entirely for
  // prefers-reduced-motion users: rows are visible by default and only
  // animate FROM hidden when motion is allowed, so there's no flash either way.
  useEffect(() => {
    if (loading || prefersReduced || !rowsRef.current) return;
    const rows = rowsRef.current.children;
    if (rows.length === 0) return;
    gsap.fromTo(
      rows,
      { opacity: 0, y: 8 },
      // clearProps must list ONLY what gsap set — "all" would wipe React's
      // inline gridTemplateColumns/fontFamily and collapse the row grid.
      { opacity: 1, y: 0, duration: 0.35, ease: "power2.out", stagger: 0.03, clearProps: "opacity,transform" },
    );
  }, [loading, entries, prefersReduced]);

  const noData = !loading && !error && entries.length === 0;

  /** Find connected wallet in the current leaderboard entries */
  const myEntry = publicKey
    ? entries.find(
        (e) => e.trader.toLowerCase() === publicKey.toBase58().toLowerCase()
      ) ?? null
    : null;

  /** Largest volume in the current view — drives the relative depth bars. */
  const maxVolume = useMemo(() => {
    let max = 0;
    for (const e of entries) {
      const n = Number(e.totalVolume);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }, [entries]);

  return (
    <main className="min-h-screen pt-20 pb-24">
      {/* Page-scoped keyframes: the slow light sweep across the #1 row.
          Reduced-motion users get a static row (media query below). */}
      <style>{`
        @keyframes lb-sweep {
          0% { background-position: 250% 0; }
          100% { background-position: -150% 0; }
        }
        .lb-rank1-sweep {
          background-image: linear-gradient(105deg, transparent 44%, rgba(153, 69, 255, 0.09) 50%, transparent 56%);
          background-size: 250% 100%;
          background-repeat: no-repeat;
          animation: lb-sweep 4.5s linear infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .lb-rank1-sweep { animation: none; background-image: none; }
        }
      `}</style>

      <div className="mx-auto max-w-3xl px-4 sm:px-6">

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="mb-8">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // leaderboard
          </div>
          <div className="mb-1 flex items-center gap-3">
            <h1
              className="text-3xl font-medium tracking-[-0.02em] text-[var(--text)]"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              Top Traders
            </h1>
            {/* Network badge: hidden on mainnet (GH#1572) */}
            {!IS_MAINNET && (
              <span className="border border-[var(--accent)]/40 bg-[var(--accent)]/[0.07] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-[var(--accent)]" style={{ fontFamily: "var(--font-mono)" }}>
                Devnet
              </span>
            )}
          </div>
          <p className="text-[13px] text-[var(--text-secondary)]">
            Ranked by trade volume{IS_MAINNET ? "" : " on the Percolator devnet playground"} — trade count breaks ties.
          </p>
        </div>

        {/* ── Period Switcher ─────────────────────────────────────── */}
        <div className="mb-6 flex gap-0 border border-[var(--border)] p-0 w-fit">
          {(["24h", "7d", "alltime"] as Period[]).map((p, i) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-4 py-1.5 text-[10px] font-medium uppercase tracking-[0.12em] transition-colors duration-150 ${
                i > 0 ? "border-l border-[var(--border)]" : ""
              } ${
                period === p
                  ? "bg-[var(--accent)]/[0.12] text-[var(--accent)]"
                  : "bg-transparent text-[var(--text-secondary)] hover:text-[var(--text)]"
              }`}
              style={{ fontFamily: "var(--font-mono)" }}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
          <button
            onClick={() => fetchLeaderboard(period)}
            className="border-l border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]"
            title="Refresh"
          >
            ↻
          </button>
        </div>

        {/* ── My Rank / Share ─────────────────────────────────────── */}
        {!loading && (
          <div className="animate-fade-in">
            <MyRankCard entry={myEntry} walletConnected={connected} divisor={divisor} />
          </div>
        )}

        {/* ── Loading skeleton ────────────────────────────────────── */}
        {loading && (
          <div className="space-y-px">
            {Array.from({ length: 8 }).map((_, i) => (
              <ShimmerSkeleton
                key={i}
                className="h-12 border border-[var(--border)] bg-[var(--panel-bg)]"
                style={{ opacity: 1 - i * 0.08 }}
              />
            ))}
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────────── */}
        {error && !loading && (
          <div className="border border-[var(--short)]/30 bg-[var(--short)]/[0.06] px-4 py-6 text-center text-[13px] text-[var(--short)]" style={{ fontFamily: "var(--font-mono)" }}>
            {error}
          </div>
        )}

        {/* ── Empty state ─────────────────────────────────────────── */}
        {noData && (
          <div className="border border-[var(--border)] bg-[var(--panel-bg)] px-4 py-12 text-center animate-fade-in">
            <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">No trades this period</p>
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
              Be first on the board.
            </p>
            <Link
              href="/markets"
              className="mt-3 inline-block text-[11px] font-medium text-[var(--accent)] transition-colors hover:text-[var(--text)]"
            >
              Start trading →
            </Link>
          </div>
        )}

        {/* ── Table ───────────────────────────────────────────────── */}
        {!loading && !error && entries.length > 0 && (
          <div className="border border-[var(--border)] animate-fade-in">
            {/* Header row */}
            <div
              className="grid border-b border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2 text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]"
              style={{ gridTemplateColumns: "3.5rem 1fr 6rem 7rem 6rem", fontFamily: "var(--font-mono)" }}
            >
              <span>Rank</span>
              <span>Trader</span>
              <span className="text-right">Trades</span>
              <span className="text-right">Volume</span>
              <span className="hidden text-right sm:block">Active</span>
            </div>

            {/* Data rows */}
            <div ref={rowsRef}>
              {entries.map((entry) => {
                const isTop3 = entry.rank <= 3;
                const isMe = myEntry != null && entry.trader === myEntry.trader;
                const volNum = Number(entry.totalVolume);
                const volPct = maxVolume > 0 && Number.isFinite(volNum)
                  ? Math.max(2, Math.round((volNum / maxVolume) * 100))
                  : 0;
                return (
                  <div
                    key={entry.trader}
                    className={`relative grid items-center border-b border-[var(--border)]/40 px-4 py-2.5 text-[13px] transition-colors last:border-b-0 hover:bg-[var(--bg-elevated)] ${
                      entry.rank === 1 ? "lb-rank1-sweep bg-[var(--accent)]/[0.04]" : isTop3 ? "bg-[var(--accent)]/[0.02]" : ""
                    } ${isMe ? "border-l-2 border-l-[var(--accent)]" : ""}`}
                    style={{ gridTemplateColumns: "3.5rem 1fr 6rem 7rem 6rem", fontFamily: "var(--font-mono)" }}
                  >
                    {/* Relative-volume depth bar — quiet, right-aligned under the
                        volume column region, terminal order-book style. */}
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-[var(--accent)]/[0.06] to-transparent"
                      style={{ width: `${Math.round(volPct * 0.45)}%` }}
                    />

                    {/* Rank */}
                    <span
                      className="text-[12px] font-bold tabular-nums"
                      style={{ color: rankColor(entry.rank) }}
                    >
                      {String(entry.rank).padStart(2, "0")}
                    </span>

                    {/* Trader address */}
                    <span
                      className={`truncate tabular-nums ${isTop3 ? "text-[var(--text)]" : "text-[var(--text-secondary)]"}`}
                      title={entry.trader}
                    >
                      {shortenAddr(entry.trader)}
                      {isMe && <span className="ml-2 text-[9px] uppercase tracking-[0.12em] text-[var(--accent)]">you</span>}
                    </span>

                    {/* Trade count */}
                    <span className="text-right tabular-nums text-[var(--text)]">
                      {entry.tradeCount.toLocaleString()}
                    </span>

                    {/* Volume */}
                    <span className={`relative text-right tabular-nums ${isTop3 ? "text-[var(--text)]" : "text-[var(--text-secondary)]"}`}>
                      {fmtVolume(entry.totalVolume, divisor)}
                    </span>

                    {/* Last active */}
                    <span className="hidden text-right text-[11px] text-[var(--text-secondary)] sm:block">
                      {timeSince(entry.lastTradeAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Footer ──────────────────────────────────────────────── */}
        <div className="mt-4 flex items-center justify-between text-[10px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
          <span>
            {entries.length > 0 ? `Top ${entries.length} traders` : ""}
          </span>
          {generatedAt && (
            <span>Updated {timeSince(generatedAt)}</span>
          )}
        </div>

        {/* ── CTA ─────────────────────────────────────────────────── */}
        {entries.length > 0 && (
          <div className="mt-8 flex flex-col gap-4 border border-[var(--accent)]/20 bg-[var(--accent)]/[0.04] px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="mb-1 text-sm font-semibold text-[var(--text)]">
                Want to climb the board?
              </p>
              <p className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                {IS_MAINNET
                  ? "Trade permissionless perps on any live market."
                  : "Grab devnet funds from the faucet and trade any live market."}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
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
                  className="border border-[var(--border)] bg-transparent px-4 py-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
                >
                  Share
                </button>
              )}
              <Link
                href={IS_MAINNET ? "/markets" : "/faucet"}
                className="shrink-0 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-4 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--accent)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15]"
              >
                {IS_MAINNET ? "Browse Markets →" : "Get Funds →"}
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
