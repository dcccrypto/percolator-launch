"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface ScenarioMeta {
  label: string;
  description: string;
  icon: string;
  color: string;
  borderColor: string;
  accentColor: string;
  priceImpact: string;
  barColor: string;
}

const SCENARIO_META: Record<string, ScenarioMeta> = {
  "flash-crash": {
    label: "Flash Crash",
    description: "Sudden 30%+ price drop. Tests liquidation cascades & insurance fund absorption.",
    icon: "💥",
    color: "text-[#ff4d6d]",
    borderColor: "border-[#ff4d6d]",
    accentColor: "#ff4d6d",
    priceImpact: "📉 −30% Flash Crash in progress",
    barColor: "#ff4d6d",
  },
  "short-squeeze": {
    label: "Short Squeeze",
    description: "Rapid price spike forcing short closures. Funding rates spike; crank goes brrrr.",
    icon: "🚀",
    color: "text-[#4ade80]",
    borderColor: "border-[#4ade80]",
    accentColor: "#4ade80",
    priceImpact: "📈 +25% Short Squeeze in progress",
    barColor: "#4ade80",
  },
  "black-swan": {
    label: "Black Swan",
    description: "Extreme 80%+ drop. Maximum stress test. Insurance fund absorbs bad debt.",
    icon: "🦢",
    color: "text-[#a78bfa]",
    borderColor: "border-[#a78bfa]",
    accentColor: "#a78bfa",
    priceImpact: "📉 −80% Black Swan in progress",
    barColor: "#a78bfa",
  },
  "high-vol": {
    label: "High Volatility",
    description: "Sustained ±15% swings. Good for learning funding rate dynamics.",
    icon: "⚡",
    color: "text-[#facc15]",
    borderColor: "border-[#facc15]",
    accentColor: "#facc15",
    priceImpact: "⚡ ±15% High Volatility in progress",
    barColor: "#facc15",
  },
  "gentle-trend": {
    label: "Gentle Trend",
    description: "Slow sustained uptrend. Low stress; useful for exploring normal operations.",
    icon: "📈",
    color: "text-[#38bdf8]",
    borderColor: "border-[#38bdf8]",
    accentColor: "#38bdf8",
    priceImpact: "📈 +5% Gentle Trend in progress",
    barColor: "#38bdf8",
  },
};

interface ScenarioState {
  id: string;
  votes: number;
  active: boolean;
  endsAt?: number;
  cooldownUntil?: number;
  completedAt?: number;
  result?: string;
}

interface HistoryEntry {
  id: string;
  label: string;
  icon: string;
  completedAt: number;
  result: string;
  color: string;
}

interface Props {
  activeScenario?: string | null;
  onScenarioChange?: (id: string | null) => void;
}

function useCountdown(targetMs: number | null): string {
  const [display, setDisplay] = useState("");
  useEffect(() => {
    if (!targetMs) { setDisplay(""); return; }
    const tick = () => {
      const rem = targetMs - Date.now();
      if (rem <= 0) { setDisplay("Ending..."); return; }
      const m = Math.floor(rem / 60000);
      const s = Math.floor((rem % 60000) / 1000);
      setDisplay(`${m}:${s.toString().padStart(2, "0")}`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [targetMs]);
  return display;
}

function useCooldownDisplay(cooldownUntil: number | undefined): string {
  const [display, setDisplay] = useState("");
  useEffect(() => {
    if (!cooldownUntil) { setDisplay(""); return; }
    const tick = () => {
      const rem = cooldownUntil - Date.now();
      if (rem <= 0) { setDisplay(""); return; }
      const m = Math.floor(rem / 60000);
      const s = Math.floor((rem % 60000) / 1000);
      setDisplay(m > 0 ? `${m}m ${s}s` : `${s}s`);
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [cooldownUntil]);
  return display;
}

function VoteBar({ pct, barColor, active }: { pct: number; barColor: string; active: boolean }) {
  const [animPct, setAnimPct] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setAnimPct(pct), 80);
    return () => clearTimeout(t);
  }, [pct]);

  return (
    <div className="mb-2">
      <div className="h-0.5 w-full rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: `${animPct}%`,
            backgroundColor: active ? barColor : barColor + "99",
            transition: "width 0.6s cubic-bezier(0.16,1,0.3,1), background-color 0.3s",
            boxShadow: active ? `0 0 6px ${barColor}80` : "none",
          }}
        />
      </div>
    </div>
  );
}

function ScenarioCard({
  id,
  state,
  totalVotes,
  localCooldown,
  voting,
  onVote,
}: {
  id: string;
  state: ScenarioState;
  totalVotes: number;
  localCooldown: number | undefined;
  voting: string | null;
  onVote: (id: string) => void;
}) {
  const meta = SCENARIO_META[id];
  if (!meta) return null;
  const pct = totalVotes > 0 ? (state.votes / totalVotes) * 100 : 0;
  const onCooldown = localCooldown && localCooldown > Date.now();
  const cooldownDisplay = useCooldownDisplay(onCooldown ? localCooldown : undefined);
  const activeCountdown = useCountdown(state.active && state.endsAt ? state.endsAt : null);

  return (
    <div
      className={[
        "relative bg-[var(--bg)] p-3 transition-all duration-300",
        state.active
          ? `border-l-2 ${meta.borderColor} animate-pulse-border`
          : "hover:bg-white/[0.02]",
      ].join(" ")}
      style={state.active ? {
        boxShadow: `inset 0 0 20px ${meta.accentColor}08, 0 0 0 1px ${meta.accentColor}20`,
      } : undefined}
    >
      {/* Active pulse dot */}
      {state.active && (
        <div className="absolute right-2 top-2 flex items-center gap-1">
          <span className="relative flex h-1.5 w-1.5">
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
              style={{ backgroundColor: meta.accentColor }}
            />
            <span
              className="relative inline-flex h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: meta.accentColor }}
            />
          </span>
        </div>
      )}

      {/* Header */}
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-sm leading-none">{meta.icon}</span>
        <span className={`text-[10px] font-semibold ${meta.color}`}>{meta.label}</span>
        {state.active && activeCountdown && (
          <span
            className="ml-auto text-[9px] font-mono font-bold"
            style={{ color: meta.accentColor }}
          >
            {activeCountdown}
          </span>
        )}
      </div>

      {/* Description */}
      <p className="mb-2 text-[9px] leading-relaxed text-[var(--text-secondary)]">
        {state.active ? meta.priceImpact : meta.description}
      </p>

      {/* Vote bar */}
      <VoteBar pct={pct} barColor={meta.barColor} active={state.active} />
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[8px] text-[var(--text-dim)]">{state.votes} votes</span>
        <span className="text-[8px] text-[var(--text-dim)]">{pct.toFixed(0)}%</span>
      </div>

      {/* Vote button */}
      <button
        onClick={() => onVote(id)}
        disabled={voting === id || !!onCooldown || state.active}
        className={[
          "w-full border px-2 py-1 text-[9px] font-medium uppercase tracking-[0.1em] transition-all duration-200",
          state.active
            ? "cursor-default border-transparent text-[var(--text-dim)] opacity-60"
            : onCooldown
            ? "cursor-not-allowed border-white/5 text-[var(--text-dim)] opacity-50"
            : voting === id
            ? "cursor-wait border-white/10 text-[var(--text-dim)]"
            : "border-white/10 text-[var(--text-secondary)] hover:border-white/20 hover:text-[var(--text)]",
        ].join(" ")}
        style={
          !state.active && !onCooldown && voting !== id
            ? { "--hover-border-color": meta.accentColor + "40" } as React.CSSProperties
            : undefined
        }
      >
        {state.active
          ? "🔥 Running"
          : voting === id
          ? "Voting..."
          : onCooldown
          ? `Voted ✓ (${cooldownDisplay})`
          : "Vote"}
      </button>
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const ago = Math.floor((Date.now() - entry.completedAt) / 60000);
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-white/5 last:border-0">
      <span className="text-xs opacity-80">{entry.icon}</span>
      <div className="flex-1 min-w-0">
        <span className={`text-[9px] font-semibold ${entry.color}`}>{entry.label}</span>
        {entry.result && (
          <span className="ml-1.5 text-[8px] text-[var(--text-dim)]">{entry.result}</span>
        )}
      </div>
      <span className="text-[8px] text-[var(--text-dim)] shrink-0">{ago}m ago</span>
    </div>
  );
}

export function ScenarioPanel({ onScenarioChange }: Props) {
  const [states, setStates] = useState<Record<string, ScenarioState>>(
    Object.fromEntries(
      Object.keys(SCENARIO_META).map((id) => [
        id,
        { id, votes: 0, active: false },
      ])
    )
  );
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [voting, setVoting] = useState<string | null>(null);
  const [localCooldowns, setLocalCooldowns] = useState<Record<string, number>>({});
  const prevActiveRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Try to load scenario state from Supabase, fallback to local simulation
  const fetchScenarios = useCallback(async () => {
    try {
      const res = await fetch("/api/scenarios/state", { cache: "no-store" });
      if (!res.ok) throw new Error("No API");
      const data = await res.json();
      if (data && data.scenarios) {
        setStates(data.scenarios);
        return;
      }
    } catch {
      // Fallback: simulate locally with mild vote drift
      setStates((prev) => {
        const updated = { ...prev };
        const ids = Object.keys(updated);
        // Randomly increment a vote
        const lucky = ids[Math.floor(Math.random() * ids.length)];
        if (Math.random() > 0.6) {
          updated[lucky] = { ...updated[lucky], votes: updated[lucky].votes + 1 };
        }
        return updated;
      });
    }
  }, []);

  // Poll every 3 seconds
  useEffect(() => {
    fetchScenarios();
    pollRef.current = setInterval(fetchScenarios, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchScenarios]);

  // Track active scenario changes for history
  useEffect(() => {
    const currentActive = Object.values(states).find((s) => s.active);
    const prevActive = prevActiveRef.current;

    // Bug fix: old code used string.includes() which never matches UUIDs correctly.
    // Correct check: scenario is "done" when prevActive exists but currentActive is gone or changed.
    if (prevActive && (!currentActive || currentActive.id !== prevActive)) {
      // Previous scenario ended — add to history
      const meta = SCENARIO_META[prevActive];
      if (meta) {
        setHistory((prev) => [
          {
            id: `${prevActive}-${Date.now()}`,
            label: meta.label,
            icon: meta.icon,
            completedAt: Date.now(),
            result: "Completed",
            color: meta.color,
          },
          ...prev.slice(0, 4),
        ]);
      }
    }

    prevActiveRef.current = currentActive?.id ?? null;
    onScenarioChange?.(currentActive?.id ?? null);
  }, [states, onScenarioChange]);

  const handleVote = useCallback(async (scenarioId: string) => {
    if (localCooldowns[scenarioId] && localCooldowns[scenarioId] > Date.now()) return;
    if (states[scenarioId]?.active) return;
    setVoting(scenarioId);

    try {
      // Bug fix: vote endpoint is at /api/simulate/scenarios/vote, not /api/scenarios/vote
      const res = await fetch("/api/simulate/scenarios/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario: scenarioId }),
      });

      if (res.ok) {
        setStates((prev) => ({
          ...prev,
          [scenarioId]: { ...prev[scenarioId], votes: prev[scenarioId].votes + 1 },
        }));
      } else {
        // Optimistic update anyway
        setStates((prev) => ({
          ...prev,
          [scenarioId]: { ...prev[scenarioId], votes: prev[scenarioId].votes + 1 },
        }));
      }
    } catch {
      setStates((prev) => ({
        ...prev,
        [scenarioId]: { ...prev[scenarioId], votes: prev[scenarioId].votes + 1 },
      }));
    } finally {
      setVoting(null);
      setLocalCooldowns((prev) => ({ ...prev, [scenarioId]: Date.now() + 5 * 60 * 1000 }));
    }
  }, [localCooldowns, states]);

  const activeEntry = Object.values(states).find((s) => s.active);
  const activeMeta = activeEntry ? SCENARIO_META[activeEntry.id] : null;
  const totalVotes = Object.values(states).reduce((sum, s) => sum + s.votes, 0);
  const activeCountdown = useCountdown(activeEntry?.endsAt ?? null);

  return (
    <div className="rounded-none border border-white/10 bg-[var(--bg)]/80 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <div>
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Market Scenarios
          </span>
          <p className="mt-0.5 text-[9px] text-[var(--text-dim)]">
            Vote to trigger a simulated market event. Highest votes activates every 15 min.
          </p>
        </div>
        {activeEntry && activeMeta && activeCountdown && (
          <div
            className="flex items-center gap-1.5 rounded-none border px-2 py-1"
            style={{
              borderColor: activeMeta.accentColor + "40",
              backgroundColor: activeMeta.accentColor + "08",
            }}
          >
            <span className="relative flex h-1.5 w-1.5">
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                style={{ backgroundColor: activeMeta.accentColor }}
              />
              <span
                className="relative inline-flex h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: activeMeta.accentColor }}
              />
            </span>
            <span
              className="text-[9px] font-bold font-mono"
              style={{ color: activeMeta.accentColor }}
            >
              {activeCountdown}
            </span>
          </div>
        )}
      </div>

      {/* Active scenario full-width banner */}
      {activeEntry && activeMeta && (
        <div
          className="border-b px-4 py-3 animate-fade-in"
          style={{
            borderColor: activeMeta.accentColor + "30",
            background: `linear-gradient(90deg, ${activeMeta.accentColor}12 0%, transparent 100%)`,
          }}
        >
          <div className="flex items-center gap-3">
            <span className="text-2xl">{activeMeta.icon}</span>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <span
                  className="text-[10px] font-bold uppercase tracking-[0.15em]"
                  style={{ color: activeMeta.accentColor }}
                >
                  ACTIVE: {activeMeta.label}
                </span>
                {activeCountdown && (
                  <span className="text-[9px] text-[var(--text-dim)] font-mono">
                    {activeCountdown} remaining
                  </span>
                )}
              </div>
              <p className="text-[10px] font-medium" style={{ color: activeMeta.accentColor + "cc" }}>
                {activeMeta.priceImpact}
              </p>
              <p className="mt-0.5 text-[9px] text-[var(--text-secondary)]">
                {activeMeta.description}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Scenario cards grid */}
      <div className="grid grid-cols-1 gap-px bg-white/5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3">
        {Object.keys(SCENARIO_META).map((id) => (
          <ScenarioCard
            key={id}
            id={id}
            state={states[id] ?? { id, votes: 0, active: false }}
            totalVotes={totalVotes}
            localCooldown={localCooldowns[id]}
            voting={voting}
            onVote={handleVote}
          />
        ))}
      </div>

      {/* Scenario history */}
      {history.length > 0 && (
        <div className="border-t border-white/10 px-4 py-3">
          <div className="mb-2 text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            // Recent Scenarios
          </div>
          {history.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
