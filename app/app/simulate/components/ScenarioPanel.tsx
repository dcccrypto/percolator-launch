"use client";

import { useState, useEffect, useCallback } from "react";

interface Scenario {
  id: string;
  label: string;
  description: string;
  icon: string;
  color: string;
  borderColor: string;
  votes: number;
  active: boolean;
  cooldownUntil?: number; // unix ms
}

const SCENARIO_META: Record<string, Omit<Scenario, "id" | "votes" | "active" | "cooldownUntil">> = {
  "flash-crash": {
    label: "Flash Crash",
    description: "Sudden 30%+ price drop. Tests liquidation cascades & insurance fund absorption.",
    icon: "📉",
    color: "text-[var(--short)]",
    borderColor: "border-[var(--short)]/30",
  },
  "short-squeeze": {
    label: "Short Squeeze",
    description: "Rapid price spike forcing short closures. Funding rates spike; crank goes brrrr.",
    icon: "🚀",
    color: "text-[var(--warning)]",
    borderColor: "border-[var(--warning)]/30",
  },
  "black-swan": {
    label: "Black Swan",
    description: "Extreme 80%+ drop. Maximum stress test. Insurance fund absorbs bad debt.",
    icon: "🦢",
    color: "text-[var(--short)]",
    borderColor: "border-[var(--short)]/30",
  },
  "high-vol": {
    label: "High Volatility",
    description: "Sustained ±15% swings. Good for learning funding rate dynamics.",
    icon: "⚡",
    color: "text-[var(--warning)]",
    borderColor: "border-[var(--warning)]/30",
  },
  "gentle-trend": {
    label: "Gentle Trend",
    description: "Slow sustained uptrend. Low stress; useful for exploring normal operations.",
    icon: "📈",
    color: "text-[var(--long)]",
    borderColor: "border-[var(--long)]/30",
  },
};

interface Props {
  activeScenario?: string | null;
  onScenarioChange?: (id: string | null) => void;
}

export function ScenarioPanel({ activeScenario, onScenarioChange }: Props) {
  const [scenarios, setScenarios] = useState<Scenario[]>(
    Object.entries(SCENARIO_META).map(([id, meta]) => ({
      id,
      ...meta,
      votes: Math.floor(Math.random() * 40 + 5),
      active: id === activeScenario,
    }))
  );
  const [voting, setVoting] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<string>("");
  const [activeEnd, setActiveEnd] = useState<number | null>(
    activeScenario ? Date.now() + 15 * 60 * 1000 : null
  );
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});

  // Countdown ticker
  useEffect(() => {
    if (!activeEnd) { setCountdown(""); return; }
    const tick = () => {
      const remaining = activeEnd - Date.now();
      if (remaining <= 0) {
        setCountdown("Ending...");
        return;
      }
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      setCountdown(`${m}:${s.toString().padStart(2, "0")}`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [activeEnd]);

  const handleVote = useCallback(async (scenarioId: string) => {
    if (cooldowns[scenarioId] && cooldowns[scenarioId] > Date.now()) return;
    setVoting(scenarioId);

    try {
      const res = await fetch(`/api/scenarios/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: scenarioId }),
      });

      if (res.ok) {
        setScenarios((prev) =>
          prev.map((s) => s.id === scenarioId ? { ...s, votes: s.votes + 1 } : s)
        );
        // 5-minute cooldown per scenario
        setCooldowns((prev) => ({ ...prev, [scenarioId]: Date.now() + 5 * 60 * 1000 }));
      }
    } catch {
      // Optimistic update anyway for UX
      setScenarios((prev) =>
        prev.map((s) => s.id === scenarioId ? { ...s, votes: s.votes + 1 } : s)
      );
    } finally {
      setVoting(null);
    }
  }, [cooldowns]);

  const currentActive = scenarios.find((s) => s.active);
  const totalVotes = scenarios.reduce((sum, s) => sum + s.votes, 0);

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)]/50 px-4 py-2.5">
        <div>
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Market Scenarios
          </span>
          <p className="mt-0.5 text-[9px] text-[var(--text-dim)]">
            Vote to trigger a simulated market event. Highest votes activates every 15 min.
          </p>
        </div>
        {currentActive && countdown && (
          <div className="flex items-center gap-1.5 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-2 py-1">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--warning)] opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
            </span>
            <span className="text-[9px] font-bold text-[var(--warning)]" style={{ fontFamily: "var(--font-mono)" }}>
              {countdown}
            </span>
          </div>
        )}
      </div>

      {/* Active scenario banner */}
      {currentActive && (
        <div className={`border-b ${currentActive.borderColor} bg-[var(--bg-elevated)] px-4 py-2`}>
          <div className="flex items-center gap-2">
            <span className="text-base">{currentActive.icon}</span>
            <div>
              <span className={`text-[10px] font-bold uppercase tracking-[0.1em] ${currentActive.color}`}>
                ACTIVE: {currentActive.label}
              </span>
              <p className="mt-0.5 text-[9px] text-[var(--text-secondary)]">{currentActive.description}</p>
            </div>
          </div>
        </div>
      )}

      {/* Scenario cards */}
      <div className="grid grid-cols-1 gap-px bg-[var(--border)]/20 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3">
        {scenarios.map((s) => {
          const votePct = totalVotes > 0 ? (s.votes / totalVotes) * 100 : 0;
          const onCooldown = cooldowns[s.id] && cooldowns[s.id] > Date.now();

          return (
            <div
              key={s.id}
              className={[
                "relative bg-[var(--bg)] p-3 transition-colors hover:bg-[var(--bg-elevated)]",
                s.active ? `border-l-2 ${s.borderColor.replace("/30", "")}` : "",
              ].join(" ")}
            >
              {s.active && (
                <div className="absolute right-2 top-2">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--warning)] opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
                  </span>
                </div>
              )}

              {/* Icon + label */}
              <div className="mb-1.5 flex items-center gap-1.5">
                <span className="text-sm">{s.icon}</span>
                <span className={`text-[10px] font-semibold ${s.color}`}>{s.label}</span>
              </div>

              {/* Description */}
              <p className="mb-2 text-[9px] leading-relaxed text-[var(--text-secondary)]">{s.description}</p>

              {/* Vote bar */}
              <div className="mb-2">
                <div className="h-0.5 rounded-full bg-[var(--border)]">
                  <div
                    className={`h-0.5 rounded-full transition-all duration-500 ${
                      s.active
                        ? "bg-[var(--warning)]"
                        : s.color.includes("long")
                        ? "bg-[var(--long)]"
                        : s.color.includes("short")
                        ? "bg-[var(--short)]"
                        : "bg-[var(--warning)]"
                    }`}
                    style={{ width: `${votePct}%` }}
                  />
                </div>
                <div className="mt-0.5 flex items-center justify-between">
                  <span className="text-[8px] text-[var(--text-dim)]">{s.votes} votes</span>
                  <span className="text-[8px] text-[var(--text-dim)]">{votePct.toFixed(0)}%</span>
                </div>
              </div>

              {/* Vote button */}
              <button
                onClick={() => handleVote(s.id)}
                disabled={voting === s.id || !!onCooldown || s.active}
                className={[
                  "w-full border px-2 py-1 text-[9px] font-medium uppercase tracking-[0.1em] transition-all duration-200",
                  s.active
                    ? "border-[var(--warning)]/30 text-[var(--warning)] cursor-default"
                    : onCooldown
                    ? "border-[var(--border)] text-[var(--text-dim)] cursor-not-allowed opacity-50"
                    : "border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--accent)]",
                ].join(" ")}
              >
                {s.active ? "🔥 Running" : voting === s.id ? "Voting..." : onCooldown ? "Voted ✓" : "Vote"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
