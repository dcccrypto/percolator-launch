"use client";

import { useState, useEffect } from "react";
import { railwayUrl } from "@/lib/railway";

type BotStatus = "active" | "liquidated" | "idle";

interface Bot {
  id: string;
  name: string;
  type: string;
  pnl: number;
  trades: number;
  positionSize: number;
  side: "long" | "short" | "flat";
  status: BotStatus;
}

const STATUS_COLORS: Record<BotStatus, string> = {
  active: "var(--long)",
  idle: "var(--warning)",
  liquidated: "var(--short)",
};

const STATUS_LABELS: Record<BotStatus, string> = {
  active: "Active",
  idle: "Idle",
  liquidated: "Liquidated",
};

interface BotLeaderboardProps {
  isSimulationRunning: boolean;
}

export function BotLeaderboard({ isSimulationRunning }: BotLeaderboardProps) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [sortBy, setSortBy] = useState<"pnl" | "trades" | "positionSize">("pnl");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isSimulationRunning) {
      setBots([]);
      return;
    }

    const fetchBots = async () => {
      setLoading(true);
      try {
        const res = await fetch(railwayUrl("/api/simulation/bots"));
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.bots)) {
            setBots(data.bots);
          }
        }
      } catch {
        // Railway might not have this endpoint yet — keep empty
      } finally {
        setLoading(false);
      }
    };

    fetchBots();
    const interval = setInterval(fetchBots, 5000);
    return () => clearInterval(interval);
  }, [isSimulationRunning]);

  if (!isSimulationRunning) {
    return (
      <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80 p-6 text-center">
        <p className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Start simulation to view bot leaderboard
        </p>
      </div>
    );
  }

  const sortedBots = [...bots].sort((a, b) => {
    if (sortBy === "pnl") return b.pnl - a.pnl;
    if (sortBy === "positionSize") return Math.abs(b.positionSize) - Math.abs(a.positionSize);
    return b.trades - a.trades;
  });

  const totalPnl = bots.reduce((s, b) => s + b.pnl, 0);
  const totalTrades = bots.reduce((s, b) => s + b.trades, 0);

  return (
    <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)]/30 px-3 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Bot Leaderboard
        </h3>

        <div className="flex items-center gap-2">
          {loading && (
            <div className="h-3 w-3 animate-spin border border-[var(--accent)] border-t-transparent" />
          )}

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "pnl" | "trades" | "positionSize")}
            className="border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[9px] uppercase tracking-[0.1em] text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="pnl">Sort by PnL</option>
            <option value="trades">Sort by Trades</option>
            <option value="positionSize">Sort by Position</option>
          </select>
        </div>
      </div>

      {/* Table */}
      {bots.length === 0 ? (
        <div className="p-6 text-center">
          {loading ? (
            <>
              <div className="h-6 w-6 mx-auto animate-spin border-2 border-[var(--accent)] border-t-transparent" />
              <p className="mt-2 text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Loading bots...</p>
            </>
          ) : (
            <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Waiting for bot data from Railway...</p>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-[var(--border)]/30 bg-[var(--bg-elevated)]">
              <tr>
                <th className="px-3 py-2 text-left text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Rank</th>
                <th className="px-3 py-2 text-left text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Bot</th>
                <th className="px-3 py-2 text-left text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Type</th>
                <th className="px-3 py-2 text-right text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">PnL</th>
                <th className="px-3 py-2 text-right text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Position</th>
                <th className="px-3 py-2 text-right text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Trades</th>
                <th className="px-3 py-2 text-center text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">Status</th>
              </tr>
            </thead>
            <tbody>
              {sortedBots.map((bot, index) => (
                <tr
                  key={bot.id}
                  className={`border-b border-[var(--border)]/10 transition-colors hover:bg-[var(--bg-elevated)]/50 ${bot.status === "liquidated" ? "opacity-60" : ""}`}
                >
                  <td className="px-3 py-2 text-[10px] font-mono text-[var(--text-dim)]">#{index + 1}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] font-bold font-mono text-[var(--text)] ${bot.status === "liquidated" ? "line-through" : ""}`}>
                      {bot.name}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">{bot.type}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="text-[11px] font-bold font-mono" style={{ color: bot.pnl >= 0 ? "var(--long)" : "var(--short)" }}>
                      {bot.pnl >= 0 ? "+" : ""}${bot.pnl.toFixed(2)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="text-[10px] font-mono" style={{ color: bot.side === "long" ? "var(--long)" : bot.side === "short" ? "var(--short)" : "var(--text-dim)" }}>
                      {bot.side === "flat" ? "--" : `${bot.side === "long" ? "+" : "-"}${Math.abs(bot.positionSize).toLocaleString()}`}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="text-[10px] font-mono text-[var(--text)]">{bot.trades}</span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <div className="h-1.5 w-1.5" style={{ backgroundColor: STATUS_COLORS[bot.status] }} />
                      <span className="text-[8px] uppercase tracking-[0.1em]" style={{ color: STATUS_COLORS[bot.status] }}>
                        {STATUS_LABELS[bot.status]}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer Summary */}
      {bots.length > 0 && (
        <div className="border-t border-[var(--border)]/30 bg-[var(--bg-elevated)] px-3 py-2">
          <div className="grid grid-cols-4 gap-4 text-center">
            <div>
              <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-0.5">Active</p>
              <p className="text-[11px] font-bold font-mono" style={{ color: "var(--long)" }}>
                {bots.filter(b => b.status === "active").length}
              </p>
            </div>
            <div>
              <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-0.5">Liquidated</p>
              <p className="text-[11px] font-bold font-mono" style={{ color: "var(--short)" }}>
                {bots.filter(b => b.status === "liquidated").length}
              </p>
            </div>
            <div>
              <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-0.5">Net PnL</p>
              <p className="text-[11px] font-bold font-mono" style={{ color: totalPnl >= 0 ? "var(--long)" : "var(--short)" }}>
                {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-0.5">Total Trades</p>
              <p className="text-[11px] font-bold font-mono text-[var(--text)]">{totalTrades}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
