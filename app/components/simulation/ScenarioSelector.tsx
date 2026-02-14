"use client";

import { useState } from "react";

interface Scenario {
  id: string;
  name: string;
  description: string;
  duration: string;
  risk: "low" | "medium" | "high" | "extreme";
}

const SCENARIOS: Scenario[] = [
  {
    id: "calm",
    name: "Calm Markets",
    description: "Low volatility, stable price action",
    duration: "5min",
    risk: "low",
  },
  {
    id: "bull",
    name: "Bull Trend",
    description: "Trending upward with moderate volatility",
    duration: "5min",
    risk: "medium",
  },
  {
    id: "crash",
    name: "Flash Crash",
    description: "Rapid price decline triggering liquidations",
    duration: "2min",
    risk: "extreme",
  },
  {
    id: "squeeze",
    name: "Short Squeeze",
    description: "Extreme funding rates, cascading longs",
    duration: "3min",
    risk: "high",
  },
  {
    id: "whale",
    name: "Whale Impact",
    description: "Large position impacts market dynamics",
    duration: "5min",
    risk: "medium",
  },
  {
    id: "blackswan",
    name: "Black Swan",
    description: "Extreme volatility stress test",
    duration: "1min",
    risk: "extreme",
  },
];

const RISK_COLORS = {
  low: "var(--long)",
  medium: "rgb(250, 204, 21)", // amber-400
  high: "rgb(251, 146, 60)", // orange-400
  extreme: "var(--short)",
};

interface ScenarioSelectorProps {
  activeScenario: string | null;
  onScenarioSelect: (scenarioId: string, params?: Record<string, number>) => Promise<void>;
  disabled?: boolean;
}

export function ScenarioSelector({ activeScenario, onScenarioSelect, disabled }: ScenarioSelectorProps) {
  const [showCustom, setShowCustom] = useState(false);
  const [customParams, setCustomParams] = useState({
    volatility: 50,
    trend: 0,
    speed: 50,
  });
  const [loading, setLoading] = useState<string | null>(null);

  const handleScenarioClick = async (scenarioId: string) => {
    if (disabled || loading) return;
    
    setLoading(scenarioId);
    try {
      await onScenarioSelect(scenarioId);
    } finally {
      setLoading(null);
    }
  };

  const handleCustomApply = async () => {
    if (disabled || loading) return;
    
    setLoading("custom");
    try {
      await onScenarioSelect("custom", customParams);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-2">
      {/* Scenario Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
        {SCENARIOS.map((scenario) => {
          const isActive = activeScenario === scenario.id;
          const isLoading = loading === scenario.id;
          
          return (
            <button
              key={scenario.id}
              onClick={() => handleScenarioClick(scenario.id)}
              disabled={disabled || loading !== null}
              className={`
                relative rounded-none border p-3 text-left transition-all
                ${isActive 
                  ? "border-[var(--accent)] bg-[var(--accent)]/10" 
                  : "border-[var(--border)]/50 bg-[var(--bg)]/80 hover:bg-[var(--bg-elevated)] hover:border-[var(--border)]"
                }
                ${disabled || loading !== null ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
              `}
            >
              {/* Status indicator */}
              <div className="absolute top-2 right-2 flex items-center gap-1">
                <div 
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: RISK_COLORS[scenario.risk] }}
                  title={`${scenario.risk} risk`}
                />
                {isLoading && (
                  <div className="h-3 w-3 animate-spin rounded-full border border-[var(--accent)] border-t-transparent" />
                )}
              </div>

              <div className="space-y-1">
                <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--text)]">
                  {scenario.name}
                </p>
                <p className="text-[9px] text-[var(--text-secondary)] leading-tight">
                  {scenario.description}
                </p>
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
                    {scenario.duration}
                  </span>
                  <span 
                    className="text-[8px] uppercase tracking-[0.15em]"
                    style={{ color: RISK_COLORS[scenario.risk] }}
                  >
                    {scenario.risk}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Custom Scenario */}
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
        <button
          onClick={() => setShowCustom(!showCustom)}
          className="flex w-full items-center justify-between px-3 py-2 text-left transition-colors hover:bg-[var(--bg-elevated)]"
        >
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text)]">
            Custom Scenario
          </span>
          <span className={`text-[9px] text-[var(--text-dim)] transition-transform ${showCustom ? "rotate-180" : ""}`}>
            ▾
          </span>
        </button>

        {showCustom && (
          <div className="border-t border-[var(--border)]/30 p-3 space-y-3">
            {/* Volatility */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  Volatility
                </label>
                <span className="text-[10px] font-mono text-[var(--text)]">
                  {customParams.volatility}%
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={customParams.volatility}
                onChange={(e) => setCustomParams({ ...customParams, volatility: parseInt(e.target.value) })}
                className="w-full h-1 bg-[var(--border)] accent-[var(--accent)] cursor-pointer"
              />
            </div>

            {/* Trend */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  Trend Bias
                </label>
                <span className="text-[10px] font-mono text-[var(--text)]">
                  {customParams.trend > 0 ? "+" : ""}{customParams.trend}
                </span>
              </div>
              <input
                type="range"
                min="-50"
                max="50"
                value={customParams.trend}
                onChange={(e) => setCustomParams({ ...customParams, trend: parseInt(e.target.value) })}
                className="w-full h-1 bg-[var(--border)] accent-[var(--accent)] cursor-pointer"
              />
            </div>

            {/* Speed */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
                  Speed
                </label>
                <span className="text-[10px] font-mono text-[var(--text)]">
                  {customParams.speed}%
                </span>
              </div>
              <input
                type="range"
                min="10"
                max="100"
                value={customParams.speed}
                onChange={(e) => setCustomParams({ ...customParams, speed: parseInt(e.target.value) })}
                className="w-full h-1 bg-[var(--border)] accent-[var(--accent)] cursor-pointer"
              />
            </div>

            <button
              onClick={handleCustomApply}
              disabled={disabled || loading !== null}
              className={`
                w-full rounded-none border border-[var(--accent)] bg-[var(--accent)]/10 px-4 py-2 
                text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--accent)]
                transition-colors hover:bg-[var(--accent)]/20
                ${disabled || loading !== null ? "opacity-50 cursor-not-allowed" : ""}
              `}
            >
              {loading === "custom" ? "Applying..." : "Apply Custom"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
