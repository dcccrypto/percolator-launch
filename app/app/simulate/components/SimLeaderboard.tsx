"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";

/* ── Types ───────────────────────────────────────────────── */

interface LeaderboardEntry {
  rank: number;
  wallet: string;
  display_name: string | null;
  total_pnl: number;
  total_deposited: number;
  trade_count: number;
  win_count: number;
  liquidation_count: number;
  best_trade: number | null;
  worst_trade: number | null;
  roi_pct: number;
  win_rate: number;
}

type Period = "weekly" | "alltime";

/* ── Formatters ─────────────────────────────────────────── */

function truncateWallet(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function fmtPnl(rawPnl: number): string {
  // DB stores PnL in 6-decimal token units (1_000_000 = $1.00 simUSDC)
  const pnl = rawPnl / 1_000_000;
  const sign = pnl >= 0 ? "+" : "";
  const abs = Math.abs(pnl);
  if (abs >= 1_000_000) return `${sign}$${(pnl / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(pnl / 1_000).toFixed(1)}K`;
  return `${sign}$${pnl.toFixed(2)}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

/* ── Skeleton row ───────────────────────────────────────── */
function SkeletonRow() {
  return (
    <tr className="border-b border-white/5">
      {[40, 96, 72, 56, 40, 64, 36].map((w, i) => (
        <td key={i} className="px-3 py-2.5">
          <div
            className="h-3 animate-pulse rounded bg-white/[0.06]"
            style={{ width: w }}
          />
        </td>
      ))}
    </tr>
  );
}

/* ── Copy button ────────────────────────────────────────── */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="ml-1.5 shrink-0 text-[9px] text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
      title="Copy wallet address"
    >
      {copied ? "✓" : "⎘"}
    </button>
  );
}

/* ── Countdown ──────────────────────────────────────────── */
function useCountdown(): string {
  const [label, setLabel] = useState("");

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      // Next Monday 00:00 UTC
      const next = new Date(now);
      const day = now.getUTCDay(); // 0=Sun
      const daysUntilMon = (8 - day) % 7 || 7;
      next.setUTCDate(now.getUTCDate() + daysUntilMon);
      next.setUTCHours(0, 0, 0, 0);

      const diff = next.getTime() - Date.now();
      if (diff <= 0) { setLabel("Resetting…"); return; }
      const d = Math.floor(diff / 86_400_000);
      const h = Math.floor((diff % 86_400_000) / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      setLabel(d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`);
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);

  return label;
}

/* ── Main component ─────────────────────────────────────── */

interface Props {
  marketKey?: string;
}

export function SimLeaderboard({ marketKey }: Props) {
  const { publicKey } = useWallet();
  const [period, setPeriod] = useState<Period>("weekly");
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const countdown = useCountdown();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLeaderboard = useCallback(async (p: Period = period) => {
    try {
      setLoading(true);
      const res = await fetch(`/api/simulate/leaderboard?period=${p}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setEntries(json.entries ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load leaderboard");
    } finally {
      setLoading(false);
    }
  }, [period]);

  // Initial fetch + auto-refresh every 10s
  useEffect(() => {
    fetchLeaderboard(period);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => fetchLeaderboard(period), 10_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [period, fetchLeaderboard]);

  const myWallet = publicKey?.toBase58();
  const myEntry = myWallet ? entries.find((e) => e.wallet === myWallet) : null;

  /* ─── Empty state ───────────────────────────────────────── */
  const EmptyState = () => (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <div className="text-4xl">🏆</div>
      <div>
        <p className="text-[13px] font-semibold text-[var(--text)]">
          No trades yet. Be the first!
        </p>
        <p className="mt-1 text-[11px] text-[var(--text-dim)]">
          Climb the leaderboard — every trade counts.
        </p>
      </div>
      <Link
        href="/simulate"
        className="inline-flex items-center gap-1.5 border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.12]"
      >
        Start Trading →
      </Link>
    </div>
  );

  /* ─── Mobile card layout ────────────────────────────────── */
  const MobileCards = () => (
    <div className="space-y-2 p-3 sm:hidden">
      {entries.slice(0, 20).map((e) => {
        const isMe = myWallet && e.wallet === myWallet;
        const rankIcon =
          e.rank === 1 ? "🥇" : e.rank === 2 ? "🥈" : e.rank === 3 ? "🥉" : null;
        return (
          <div
            key={e.wallet}
            className={[
              "rounded-none border p-3 transition-all",
              isMe
                ? "border-[var(--accent)]/30 bg-[var(--accent)]/[0.06] shadow-[0_0_12px_var(--accent)]/10"
                : "border-white/5 bg-white/[0.02]",
            ].join(" ")}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-lg">
                  {rankIcon ?? (
                    <span
                      className="text-[11px] font-bold text-[var(--text-dim)]"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      #{e.rank}
                    </span>
                  )}
                </span>
                <div>
                  <div className="flex items-center gap-1">
                    <span
                      className={[
                        "text-[12px] font-medium",
                        isMe ? "text-[var(--accent)]" : "text-[var(--text-secondary)]",
                      ].join(" ")}
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {e.display_name ?? truncateWallet(e.wallet)}
                    </span>
                    {isMe && (
                      <span className="text-[9px] font-bold text-[var(--accent)]">(you)</span>
                    )}
                    <CopyButton text={e.wallet} />
                  </div>
                </div>
              </div>
              <span
                className={[
                  "text-[13px] font-bold",
                  e.total_pnl >= 0 ? "text-[var(--long)]" : "text-[var(--short)]",
                ].join(" ")}
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {fmtPnl(e.total_pnl)}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-[var(--text-dim)]">
              <div>
                <span className="block uppercase tracking-[0.1em]">ROI</span>
                <span
                  className={e.roi_pct >= 0 ? "text-[var(--long)]" : "text-[var(--short)]"}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {fmtPct(e.roi_pct)}
                </span>
              </div>
              <div>
                <span className="block uppercase tracking-[0.1em]">Win Rate</span>
                <span
                  className={e.win_rate >= 50 ? "text-[var(--long)]" : "text-[var(--text-secondary)]"}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {e.win_rate.toFixed(1)}%
                </span>
              </div>
              <div>
                <span className="block uppercase tracking-[0.1em]">Trades</span>
                <span style={{ fontFamily: "var(--font-mono)" }}>{e.trade_count}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  /* ─── Desktop table ─────────────────────────────────────── */
  const DesktopTable = () => (
    <div className="hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[640px]">
        <thead>
          <tr className="sticky top-0 border-b border-white/10 bg-[var(--bg)]/95 backdrop-blur-sm">
            {(["#", "Wallet", "PnL", "ROI%", "Trades", "Win Rate", "Liqs"] as const).map(
              (h) => (
                <th
                  key={h}
                  className={`px-3 py-2.5 text-[9px] font-semibold uppercase tracking-[0.15em] text-[var(--text-dim)] ${
                    h === "#" || h === "Wallet" ? "text-left" : "text-right"
                  }`}
                >
                  {h}
                </th>
              )
            )}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
            : entries.map((e, idx) => {
                const isMe = myWallet && e.wallet === myWallet;
                const isEven = idx % 2 === 0;
                const rankIcon =
                  e.rank === 1
                    ? "🥇"
                    : e.rank === 2
                    ? "🥈"
                    : e.rank === 3
                    ? "🥉"
                    : null;

                return (
                  <tr
                    key={e.wallet}
                    className={[
                      "group border-b border-white/[0.04] transition-all last:border-b-0",
                      isMe
                        ? "bg-[var(--accent)]/[0.07] shadow-[inset_0_0_0_1px_var(--accent)]/10 hover:bg-[var(--accent)]/[0.10]"
                        : isEven
                        ? "bg-white/[0.01] hover:bg-white/[0.04]"
                        : "hover:bg-white/[0.04]",
                    ].join(" ")}
                  >
                    {/* Rank */}
                    <td className="px-3 py-2.5">
                      <span
                        className={[
                          "text-[11px] font-bold",
                          !rankIcon &&
                            (e.rank <= 10
                              ? "text-[var(--text-secondary)]"
                              : "text-[var(--text-dim)]"),
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {rankIcon ?? `#${e.rank}`}
                      </span>
                    </td>

                    {/* Wallet */}
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-0">
                        <span
                          className={[
                            "text-[11px] font-medium",
                            isMe
                              ? "text-[var(--accent)]"
                              : "text-[var(--text-secondary)]",
                          ].join(" ")}
                          style={{ fontFamily: "var(--font-mono)" }}
                          title={e.wallet}
                        >
                          {e.display_name ?? truncateWallet(e.wallet)}
                        </span>
                        {isMe && (
                          <span className="ml-1.5 text-[9px] font-bold text-[var(--accent)]">
                            (you)
                          </span>
                        )}
                        <CopyButton text={e.wallet} />
                      </div>
                    </td>

                    {/* PnL */}
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className={[
                          "text-[11px] font-bold",
                          e.total_pnl >= 0
                            ? "text-[var(--long)]"
                            : "text-[var(--short)]",
                        ].join(" ")}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {fmtPnl(e.total_pnl)}
                      </span>
                    </td>

                    {/* ROI% */}
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className={[
                          "text-[10px]",
                          e.roi_pct >= 0
                            ? "text-[var(--long)]"
                            : "text-[var(--short)]",
                        ].join(" ")}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {fmtPct(e.roi_pct)}
                      </span>
                    </td>

                    {/* Trades */}
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className="text-[11px] text-[var(--text-secondary)]"
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {e.trade_count}
                      </span>
                    </td>

                    {/* Win Rate */}
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className={[
                          "text-[10px]",
                          e.win_rate >= 50
                            ? "text-[var(--long)]"
                            : "text-[var(--text-secondary)]",
                        ].join(" ")}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {e.win_rate.toFixed(1)}%
                      </span>
                    </td>

                    {/* Liquidations */}
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className={[
                          "text-[10px]",
                          e.liquidation_count > 0
                            ? "text-[var(--short)]"
                            : "text-[var(--text-dim)]",
                        ].join(" ")}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {e.liquidation_count}
                      </span>
                    </td>
                  </tr>
                );
              })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="overflow-hidden rounded-none border border-white/10 bg-white/[0.02] backdrop-blur-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5">
        {/* Left: title + tabs */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            🏆 Leaderboard
          </span>
          {marketKey && (
            <span className="border border-white/10 px-1.5 py-0.5 text-[9px] text-[var(--text-dim)]">
              {marketKey}
            </span>
          )}

          {/* Period tabs */}
          <div className="flex overflow-hidden border border-white/10">
            {(["weekly", "alltime"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={[
                  "px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[0.12em] transition-all",
                  period === p
                    ? "bg-[var(--accent)]/10 text-[var(--accent)]"
                    : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]",
                ].join(" ")}
              >
                {p === "weekly" ? "This Week" : "All-Time"}
              </button>
            ))}
          </div>
        </div>

        {/* Right: countdown + refresh */}
        <div className="flex items-center gap-3">
          {period === "weekly" && countdown && (
            <div className="flex items-center gap-1 text-[9px] text-[var(--text-dim)]">
              <svg
                width="8"
                height="8"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Resets in {countdown}
            </div>
          )}
          <button
            onClick={() => fetchLeaderboard(period)}
            className="text-[10px] text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Error */}
      {error && !loading && (
        <div className="border-b border-white/5 bg-[var(--short)]/5 px-4 py-3">
          <p className="text-[11px] text-[var(--short)]">{error}</p>
          <p className="mt-0.5 text-[10px] text-[var(--text-dim)]">
            Leaderboard data not yet available — start trading!
          </p>
        </div>
      )}

      {/* Content */}
      {!error && entries.length === 0 && !loading ? (
        <EmptyState />
      ) : (
        <>
          <MobileCards />
          <DesktopTable />
        </>
      )}

      {/* "You are not in top 100" footer */}
      {myWallet && !myEntry && !loading && entries.length > 0 && (
        <div className="border-t border-white/5 bg-[var(--accent)]/[0.03] px-4 py-2.5">
          <p className="text-[10px] text-[var(--text-dim)]">
            You&apos;re not yet ranked this {period === "weekly" ? "week" : "time"}. Make
            some trades to appear on the leaderboard!
          </p>
        </div>
      )}

      {/* You ARE ranked — glow pill */}
      {myEntry && (
        <div className="flex items-center justify-between border-t border-[var(--accent)]/20 bg-[var(--accent)]/[0.04] px-4 py-2">
          <p className="text-[10px] text-[var(--accent)]">
            You are ranked{" "}
            <span className="font-bold">
              {myEntry.rank === 1
                ? "🥇"
                : myEntry.rank === 2
                ? "🥈"
                : myEntry.rank === 3
                ? "🥉"
                : `#${myEntry.rank}`}
            </span>{" "}
            with{" "}
            <span
              className={
                myEntry.total_pnl >= 0
                  ? "font-bold text-[var(--long)]"
                  : "font-bold text-[var(--short)]"
              }
            >
              {fmtPnl(myEntry.total_pnl)}
            </span>
          </p>
          <span className="text-[9px] text-[var(--text-dim)]">
            {myEntry.win_rate.toFixed(1)}% win rate · {myEntry.trade_count} trades
          </span>
        </div>
      )}
    </div>
  );
}
