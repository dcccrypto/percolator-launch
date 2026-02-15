"use client";

import { useState, useEffect } from "react";

interface SimulationMetrics {
  activeBots: number;
  totalTrades: number;
  liquidations: number;
  insuranceDelta: number;
  fundingRate: number;
  pnlDistribution: {
    profitable: number;
    breakeven: number;
    losing: number;
  };
}

// Mock metrics for demo
function generateMockMetrics(): SimulationMetrics {
  return {
    activeBots: Math.floor(Math.random() * 20) + 10,
    totalTrades: Math.floor(Math.random() * 500) + 100,
    liquidations: Math.floor(Math.random() * 15),
    insuranceDelta: Math.random() * 10000 - 2000,
    fundingRate: Math.random() * 0.2 - 0.1,
    pnlDistribution: {
      profitable: Math.floor(Math.random() * 60) + 20,
      breakeven: Math.floor(Math.random() * 20) + 5,
      losing: Math.floor(Math.random() * 40) + 10,
    },
  };
}

interface SimulationMetricsProps {
  isSimulationRunning: boolean;
}

export function SimulationMetrics({ isSimulationRunning }: SimulationMetricsProps) {
  const [metrics, setMetrics] = useState<SimulationMetrics | null>(null);
  const [loading, setLoading] = useState(false);

  // Poll metrics every 3 seconds
  useEffect(() => {
    if (!isSimulationRunning) {
      setMetrics(null);
      return;
    }

    const fetchMetrics = () => {
      setLoading(true);
      // Simulate API call
      setTimeout(() => {
        setMetrics(generateMockMetrics());
        setLoading(false);
      }, 300);
    };

    // Initial fetch
    fetchMetrics();

    // Poll every 3 seconds
    const interval = setInterval(fetchMetrics, 3000);

    return () => clearInterval(interval);
  }, [isSimulationRunning]);

  if (!isSimulationRunning) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-6 text-center">
        <p className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Start simulation to view metrics
        </p>
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-6 text-center">
        <div className="h-6 w-6 mx-auto animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
        <p className="mt-2 text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Loading metrics...
        </p>
      </div>
    );
  }

  const total = metrics.pnlDistribution.profitable + metrics.pnlDistribution.breakeven + metrics.pnlDistribution.losing;
  const profitablePercent = total > 0 ? (metrics.pnlDistribution.profitable / total) * 100 : 0;
  const breakevenPercent = total > 0 ? (metrics.pnlDistribution.breakeven / total) * 100 : 0;
  const losingPercent = total > 0 ? (metrics.pnlDistribution.losing / total) * 100 : 0;

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)]/30 px-3 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Live Metrics
        </h3>
        
        {loading && (
          <div className="h-3 w-3 animate-spin rounded-full border border-[var(--accent)] border-t-transparent" />
        )}
      </div>

      {/* Main Stats Grid */}
      <div className="grid grid-cols-3 gap-px border-b border-[var(--border)]/30">
        <div className="p-3 border-r border-[var(--border)]/20">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">
            Active Bots
          </p>
          <p className="text-[18px] font-bold font-mono text-[var(--text)]">
            {metrics.activeBots}
          </p>
        </div>

        <div className="p-3 border-r border-[var(--border)]/20">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">
            Total Trades
          </p>
          <p className="text-[18px] font-bold font-mono text-[var(--text)]">
            {metrics.totalTrades.toLocaleString()}
          </p>
        </div>

        <div className="p-3">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">
            Liquidations
          </p>
          <p className="text-[18px] font-bold font-mono" style={{ color: "var(--short)" }}>
            {metrics.liquidations}
          </p>
        </div>
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-2 gap-px border-b border-[var(--border)]/30">
        <div className="p-3 border-r border-[var(--border)]/20">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">
            Insurance Delta
          </p>
          <p 
            className="text-[14px] font-bold font-mono"
            style={{ color: metrics.insuranceDelta >= 0 ? "var(--long)" : "var(--short)" }}
          >
            {metrics.insuranceDelta >= 0 ? "+" : ""}${metrics.insuranceDelta.toFixed(2)}
          </p>
        </div>

        <div className="p-3">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-1">
            Funding Rate
          </p>
          <p 
            className="text-[14px] font-bold font-mono"
            style={{ color: metrics.fundingRate >= 0 ? "var(--long)" : "var(--short)" }}
          >
            {metrics.fundingRate >= 0 ? "+" : ""}{(metrics.fundingRate * 100).toFixed(3)}%
          </p>
        </div>
      </div>

      {/* PnL Distribution */}
      <div className="p-3">
        <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)] mb-2">
          PnL Distribution
        </p>

        {/* Distribution Bar */}
        <div className="flex h-2 w-full overflow-hidden rounded-none border border-[var(--border)]/30 mb-2">
          {profitablePercent > 0 && (
            <div 
              className="h-full transition-all duration-500"
              style={{ 
                width: `${profitablePercent}%`,
                backgroundColor: "var(--long)",
              }}
            />
          )}
          {breakevenPercent > 0 && (
            <div 
              className="h-full transition-all duration-500"
              style={{ 
                width: `${breakevenPercent}%`,
                backgroundColor: "rgb(250, 204, 21)", // amber-400
              }}
            />
          )}
          {losingPercent > 0 && (
            <div 
              className="h-full transition-all duration-500"
              style={{ 
                width: `${losingPercent}%`,
                backgroundColor: "var(--short)",
              }}
            />
          )}
        </div>

        {/* Distribution Stats */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className="flex items-center gap-1 mb-0.5">
              <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "var(--long)" }} />
              <span className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                Profit
              </span>
            </div>
            <p className="text-[11px] font-bold font-mono text-[var(--text)]">
              {metrics.pnlDistribution.profitable} ({profitablePercent.toFixed(0)}%)
            </p>
          </div>

          <div>
            <div className="flex items-center gap-1 mb-0.5">
              <div className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              <span className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                Even
              </span>
            </div>
            <p className="text-[11px] font-bold font-mono text-[var(--text)]">
              {metrics.pnlDistribution.breakeven} ({breakevenPercent.toFixed(0)}%)
            </p>
          </div>

          <div>
            <div className="flex items-center gap-1 mb-0.5">
              <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "var(--short)" }} />
              <span className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                Loss
              </span>
            </div>
            <p className="text-[11px] font-bold font-mono text-[var(--text)]">
              {metrics.pnlDistribution.losing} ({losingPercent.toFixed(0)}%)
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
