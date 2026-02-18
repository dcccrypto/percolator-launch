"use client";

import { useEffect, useState, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { getSupabase } from "@/lib/supabase";

interface LeaderboardEntry {
  rank: number;
  wallet: string;
  pnl: number;
  roi_pct: number;
  trades: number;
  win_rate: number;
  liquidations: number;
}

function truncateWallet(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function fmtPnl(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "";
  if (Math.abs(pnl) >= 1000) return `${sign}$${(pnl / 1000).toFixed(1)}K`;
  return `${sign}$${pnl.toFixed(2)}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

interface Props {
  marketKey?: string;
}

export function SimLeaderboard({ marketKey }: Props) {
  const { publicKey } = useWallet();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weekReset, setWeekReset] = useState<Date | null>(null);
  const [timeUntilReset, setTimeUntilReset] = useState("");

  const fetchLeaderboard = useCallback(async () => {
    try {
      setLoading(true);
      const { data, error: qErr } = await getSupabase()
        .from("sim_leaderboard" as never)
        .select("*")
        .order("pnl", { ascending: false })
        .limit(20) as { data: LeaderboardEntry[] | null; error: unknown };

      if (qErr) throw new Error(String(qErr));
      setEntries(
        (data ?? []).map((row, i) => ({ ...row, rank: i + 1 }))
      );
      setError(null);

      // Calculate next weekly reset (Monday 00:00 UTC)
      const now = new Date();
      const nextMonday = new Date(now);
      nextMonday.setUTCDate(now.getUTCDate() + ((8 - now.getUTCDay()) % 7 || 7));
      nextMonday.setUTCHours(0, 0, 0, 0);
      setWeekReset(nextMonday);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load leaderboard");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLeaderboard();
    const interval = setInterval(fetchLeaderboard, 60_000);
    return () => clearInterval(interval);
  }, [fetchLeaderboard]);

  // Countdown timer
  useEffect(() => {
    if (!weekReset) return;
    const tick = () => {
      const now = Date.now();
      const diff = weekReset.getTime() - now;
      if (diff <= 0) { setTimeUntilReset("Resetting..."); return; }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      setTimeUntilReset(d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`);
    };
    tick();
    const t = setInterval(tick, 60_000);
    return () => clearInterval(t);
  }, [weekReset]);

  const myWallet = publicKey?.toBase58();

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)]/50 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Leaderboard
          </span>
          {marketKey && (
            <span className="rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[9px] text-[var(--text-dim)]">
              {marketKey}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {timeUntilReset && (
            <div className="flex items-center gap-1 text-[9px] text-[var(--text-dim)]">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Resets in {timeUntilReset}
            </div>
          )}
          <button
            onClick={fetchLeaderboard}
            className="text-[9px] text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
          </div>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="text-[11px] text-[var(--short)]">{error}</p>
            <p className="mt-1 text-[10px] text-[var(--text-dim)]">Leaderboard data not yet available — start trading!</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-[11px] text-[var(--text-secondary)]">No trades yet this week</p>
            <p className="mt-1 text-[10px] text-[var(--text-dim)]">Be the first to climb the leaderboard!</p>
          </div>
        ) : (
          <table className="w-full min-w-[600px]">
            <thead>
              <tr className="border-b border-[var(--border)]/30 bg-[var(--bg-elevated)]">
                {["#", "Wallet", "PnL", "ROI%", "Trades", "Win Rate", "Liqs"].map((h) => (
                  <th
                    key={h}
                    className={`px-3 py-2 text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)] ${
                      h === "#" || h === "Wallet" ? "text-left" : "text-right"
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const isMe = myWallet && e.wallet === myWallet;
                return (
                  <tr
                    key={e.wallet}
                    className={[
                      "border-b border-[var(--border)]/20 transition-colors last:border-b-0",
                      isMe
                        ? "bg-[var(--accent)]/[0.06] hover:bg-[var(--accent)]/[0.09]"
                        : "hover:bg-[var(--bg-elevated)]",
                    ].join(" ")}
                  >
                    {/* Rank */}
                    <td className="px-3 py-2.5">
                      <span
                        className={[
                          "text-[11px] font-bold",
                          e.rank === 1
                            ? "text-yellow-400"
                            : e.rank === 2
                            ? "text-slate-300"
                            : e.rank === 3
                            ? "text-amber-600"
                            : "text-[var(--text-dim)]",
                        ].join(" ")}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {e.rank === 1 ? "🥇" : e.rank === 2 ? "🥈" : e.rank === 3 ? "🥉" : `#${e.rank}`}
                      </span>
                    </td>

                    {/* Wallet */}
                    <td className="px-3 py-2.5">
                      <span
                        className={[
                          "text-[11px] font-medium",
                          isMe ? "text-[var(--accent)]" : "text-[var(--text-secondary)]",
                        ].join(" ")}
                        style={{ fontFamily: "var(--font-mono)" }}
                        title={e.wallet}
                      >
                        {truncateWallet(e.wallet)}
                        {isMe && (
                          <span className="ml-1.5 text-[9px] font-bold text-[var(--accent)]">(you)</span>
                        )}
                      </span>
                    </td>

                    {/* PnL */}
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className={[
                          "text-[11px] font-bold",
                          e.pnl >= 0 ? "text-[var(--long)]" : "text-[var(--short)]",
                        ].join(" ")}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {fmtPnl(e.pnl)}
                      </span>
                    </td>

                    {/* ROI% */}
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className={[
                          "text-[10px]",
                          e.roi_pct >= 0 ? "text-[var(--long)]" : "text-[var(--short)]",
                        ].join(" ")}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {fmtPct(e.roi_pct)}
                      </span>
                    </td>

                    {/* Trades */}
                    <td className="px-3 py-2.5 text-right">
                      <span className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                        {e.trades}
                      </span>
                    </td>

                    {/* Win Rate */}
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className={[
                          "text-[10px]",
                          e.win_rate >= 50 ? "text-[var(--long)]" : "text-[var(--text-secondary)]",
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
                          e.liquidations > 0 ? "text-[var(--short)]" : "text-[var(--text-dim)]",
                        ].join(" ")}
                        style={{ fontFamily: "var(--font-mono)" }}
                      >
                        {e.liquidations}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* My rank if not in top 20 */}
      {myWallet && entries.length > 0 && !entries.find((e) => e.wallet === myWallet) && (
        <div className="border-t border-[var(--border)]/30 bg-[var(--accent)]/[0.03] px-4 py-2.5">
          <p className="text-[10px] text-[var(--text-dim)]">
            You are not yet ranked. Make some trades to appear on the leaderboard!
          </p>
        </div>
      )}
    </div>
  );
}
