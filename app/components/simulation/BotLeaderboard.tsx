"use client";

import { useState, useEffect } from "react";

type BotStatus = "active" | "liquidated" | "idle";
type BotType = "aggressive" | "conservative" | "arbitrage" | "trend" | "contrarian";

interface Bot {
  id: string;
  name: string;
  type: BotType;
  pnl: number;
  trades: number;
  status: BotStatus;
}

// Mock bot data generator
function generateMockBots(): Bot[] {
  const types: BotType[] = ["aggressive", "conservative", "arbitrage", "trend", "contrarian"];
  const statuses: BotStatus[] = ["active", "active", "active", "idle", "liquidated"];
  
  return Array.from({ length: 15 }, (_, i) => ({
    id: `bot_${i + 1}`,
    name: `Bot_${i + 1}`,
    type: types[Math.floor(Math.random() * types.length)],
    pnl: Math.random() * 20000 - 5000,
    trades: Math.floor(Math.random() * 200) + 10,
    status: statuses[Math.floor(Math.random() * statuses.length)],
  }));
}

const STATUS_COLORS: Record<BotStatus, string> = {
  active: "var(--long)",
  idle: "rgb(250, 204, 21)", // amber-400
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
  const [sortBy, setSortBy] = useState<"pnl" | "trades">("pnl");
  const [loading, setLoading] = useState(false);

  // Poll bot data every 5 seconds
  useEffect(() => {
    if (!isSimulationRunning) {
      setBots([]);
      return;
    }

    const fetchBots = () => {
      setLoading(true);
      // Simulate API call
      setTimeout(() => {
        setBots(generateMockBots());
        setLoading(false);
      }, 300);
    };

    // Initial fetch
    fetchBots();

    // Poll every 5 seconds
    const interval = setInterval(fetchBots, 5000);

    return () => clearInterval(interval);
  }, [isSimulationRunning]);

  if (!isSimulationRunning) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-6 text-center">
        <p className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Start simulation to view bot leaderboard
        </p>
      </div>
    );
  }

  const sortedBots = [...bots].sort((a, b) => {
    if (sortBy === "pnl") {
      return b.pnl - a.pnl;
    }
    return b.trades - a.trades;
  });

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)]/30 px-3 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Bot Leaderboard
        </h3>
        
        <div className="flex items-center gap-2">
          {loading && (
            <div className="h-3 w-3 animate-spin rounded-full border border-[var(--accent)] border-t-transparent" />
          )}
          
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as "pnl" | "trades")}
            className="rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[9px] uppercase tracking-[0.1em] text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          >
            <option value="pnl">Sort by PnL</option>
            <option value="trades">Sort by Trades</option>
          </select>
        </div>
      </div>

      {/* Table */}
      {bots.length === 0 ? (
        <div className="p-6 text-center">
          <div className="h-6 w-6 mx-auto animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
          <p className="mt-2 text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Loading bots...
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-[var(--border)]/30 bg-[var(--bg-elevated)]">
              <tr>
                <th className="px-3 py-2 text-left text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  Rank
                </th>
                <th className="px-3 py-2 text-left text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  Bot
                </th>
                <th className="px-3 py-2 text-left text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  Type
                </th>
                <th className="px-3 py-2 text-right text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  PnL
                </th>
                <th className="px-3 py-2 text-right text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  Trades
                </th>
                <th className="px-3 py-2 text-center text-[8px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedBots.map((bot, index) => (
                <tr 
                  key={bot.id}
                  className={`
                    border-b border-[var(--border)]/10 transition-colors hover:bg-[var(--bg-elevated)]/50
                    ${bot.status === "liquidated" ? "opacity-60" : ""}
                  `}
                >
                  {/* Rank */}
                  <td className="px-3 py-2 text-[10px] font-mono text-[var(--text-dim)]">
                    #{index + 1}
                  </td>

                  {/* Bot Name */}
                  <td className="px-3 py-2">
                    <span 
                      className={`text-[10px] font-bold font-mono text-[var(--text)] ${
                        bot.status === "liquidated" ? "line-through" : ""
                      }`}
                    >
                      {bot.name}
                    </span>
                  </td>

                  {/* Type */}
                  <td className="px-3 py-2">
                    <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">
                      {bot.type}
                    </span>
                  </td>

                  {/* PnL */}
                  <td className="px-3 py-2 text-right">
                    <span 
                      className="text-[11px] font-bold font-mono"
                      style={{ 
                        color: bot.pnl >= 0 ? "var(--long)" : "var(--short)" 
                      }}
                    >
                      {bot.pnl >= 0 ? "+" : ""}${bot.pnl.toFixed(2)}
                    </span>
                  </td>

                  {/* Trades */}
                  <td className="px-3 py-2 text-right">
                    <span className="text-[10px] font-mono text-[var(--text)]">
                      {bot.trades}
                    </span>
                  </td>

                  {/* Status */}
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <div 
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: STATUS_COLORS[bot.status] }}
                      />
                      <span 
                        className="text-[8px] uppercase tracking-[0.1em]"
                        style={{ color: STATUS_COLORS[bot.status] }}
                      >
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
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-0.5">
                Active
              </p>
              <p className="text-[11px] font-bold font-mono" style={{ color: "var(--long)" }}>
                {bots.filter(b => b.status === "active").length}
              </p>
            </div>
            <div>
              <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-0.5">
                Idle
              </p>
              <p className="text-[11px] font-bold font-mono text-amber-400">
                {bots.filter(b => b.status === "idle").length}
              </p>
            </div>
            <div>
              <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-0.5">
                Liquidated
              </p>
              <p className="text-[11px] font-bold font-mono" style={{ color: "var(--short)" }}>
                {bots.filter(b => b.status === "liquidated").length}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
