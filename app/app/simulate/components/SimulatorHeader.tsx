"use client";

import Link from "next/link";
import { TourHelpButton } from "./GuidedWalkthrough";

const SCENARIOS: Record<string, { label: string; color: string; icon: string }> = {
  "flash-crash":    { label: "Flash Crash",    color: "text-[var(--short)]",   icon: "📉" },
  "short-squeeze":  { label: "Short Squeeze",  color: "text-[var(--warning)]", icon: "🚀" },
  "black-swan":     { label: "Black Swan",     color: "text-[var(--short)]",   icon: "🦢" },
  "high-vol":       { label: "High Volatility", color: "text-[var(--warning)]", icon: "⚡" },
  "gentle-trend":   { label: "Gentle Trend",   color: "text-[var(--long)]",    icon: "📈" },
};

interface Props {
  markets: { key: string; name: string }[];
  selectedMarket: string;
  onMarketChange: (key: string) => void;
  activeScenario?: string | null;
}

export function SimulatorHeader({ markets, selectedMarket, onMarketChange, activeScenario }: Props) {
  const scenario = activeScenario ? SCENARIOS[activeScenario] : null;

  return (
    <div className="border-b border-[var(--border)]/50 bg-[var(--bg)]/95 backdrop-blur-sm">
      {/* Top bar */}
      <div className="mx-auto max-w-7xl px-4 py-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {/* Title block */}
          <div className="min-w-0">
            <div className="mb-0.5 text-[9px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // RISK ENGINE SIMULATOR
            </div>
            <h1
              className="text-lg font-bold leading-tight text-[var(--text)] sm:text-xl"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Risk Engine Simulator
            </h1>
            <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
              Trade on real Percolator markets with simulated funds
            </p>
          </div>

          {/* Right side actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Active scenario badge */}
            {scenario && (
              <div className="flex items-center gap-1.5 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1">
                <span className="text-sm">{scenario.icon}</span>
                <span className={`text-[10px] font-medium uppercase tracking-[0.1em] ${scenario.color}`}>
                  {scenario.label}
                </span>
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--warning)] opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
                </span>
              </div>
            )}

            {/* Get simUSDC */}
            <Link
              href="/devnet-mint"
              className="inline-flex items-center gap-1.5 border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-200 hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.12]"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              Get simUSDC
            </Link>

            {/* Network badge */}
            <div className="flex items-center gap-1.5 border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              </span>
              <span className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">Devnet</span>
            </div>

            {/* Guided tour */}
            <TourHelpButton />
          </div>
        </div>
      </div>

      {/* Market tabs */}
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex gap-0 border-t border-[var(--border)]/30">
          {markets.map((m) => (
            <button
              key={m.key}
              onClick={() => onMarketChange(m.key)}
              className={[
                "px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.12em] transition-all duration-150 border-b-2",
                selectedMarket === m.key
                  ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/[0.04]"
                  : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border)]",
              ].join(" ")}
            >
              {m.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
