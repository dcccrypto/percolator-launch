"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useEngineState } from "@/hooks/useEngineState";

/* ── Event types ─────────────────────────────────────────── */
export type EventType =
  | "Trade"
  | "Liquidation"
  | "ScenarioStart"
  | "ScenarioEnd"
  | "InsuranceEvent"
  | "FundingChange";

export interface FeedEvent {
  id: string;
  type: EventType;
  icon: string;
  timestamp: number;
  title: string;
  description: string;
  detail?: string;
  color: string;
}

const EVENT_CONFIG: Record<EventType, { icon: string; color: string }> = {
  Trade:           { icon: "💹", color: "text-[#38bdf8]" },
  Liquidation:     { icon: "⚠️", color: "text-[#ff4d6d]" },
  ScenarioStart:   { icon: "🎭", color: "text-[#facc15]" },
  ScenarioEnd:     { icon: "✅", color: "text-[#4ade80]" },
  InsuranceEvent:  { icon: "🛡️", color: "text-[#a78bfa]" },
  FundingChange:   { icon: "💸", color: "text-[var(--accent)]" },
};

const ALL_TYPES: EventType[] = [
  "Trade",
  "Liquidation",
  "ScenarioStart",
  "ScenarioEnd",
  "InsuranceEvent",
  "FundingChange",
];

function formatUSDC(lamports: bigint): string {
  const n = Number(lamports) / 1e6;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 10_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

/* ── Event row ───────────────────────────────────────────── */
interface EventRowProps {
  event: FeedEvent;
  isNew: boolean;
}

function EventRow({ event, isNew }: EventRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [flash, setFlash] = useState(isNew);

  useEffect(() => {
    if (isNew) {
      const t = setTimeout(() => setFlash(false), 800);
      return () => clearTimeout(t);
    }
  }, [isNew]);

  return (
    <div
      className={[
        "border-b border-white/5 px-3 py-2 transition-all duration-500 last:border-0",
        flash ? "bg-white/[0.06]" : "hover:bg-white/[0.02]",
        event.detail ? "cursor-pointer" : "",
      ].join(" ")}
      onClick={() => event.detail && setExpanded((v) => !v)}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-sm leading-none shrink-0">{event.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[9px] font-bold uppercase tracking-[0.1em] ${event.color} truncate`}>
              {event.title}
            </span>
            <span className="shrink-0 text-[8px] text-[var(--text-dim)] tabular-nums">
              {timeAgo(event.timestamp)}
            </span>
          </div>
          <p className="mt-0.5 text-[9px] leading-relaxed text-[var(--text-secondary)] line-clamp-2">
            {event.description}
          </p>
          {event.detail && expanded && (
            <div className="mt-1.5 rounded-none border border-white/10 bg-white/5 p-2">
              <p className="text-[8px] leading-relaxed text-[var(--text-secondary)]">
                {event.detail}
              </p>
            </div>
          )}
          {event.detail && (
            <button className="mt-0.5 text-[8px] text-[var(--text-dim)] hover:text-[var(--text-secondary)] transition-colors">
              {expanded ? "▲ hide detail" : "▼ show detail"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Filter chip ─────────────────────────────────────────── */
interface FilterChipProps {
  type: EventType;
  active: boolean;
  onToggle: (t: EventType) => void;
}

function FilterChip({ type, active, onToggle }: FilterChipProps) {
  const cfg = EVENT_CONFIG[type];
  return (
    <button
      onClick={() => onToggle(type)}
      className={[
        "flex items-center gap-1 rounded-none border px-2 py-0.5 text-[8px] font-medium transition-all duration-200",
        active
          ? `border-current ${cfg.color} bg-white/5`
          : "border-white/10 text-[var(--text-dim)] hover:border-white/20",
      ].join(" ")}
    >
      <span>{cfg.icon}</span>
      <span>{type}</span>
    </button>
  );
}

/* ── Main component ──────────────────────────────────────── */
const MAX_EVENTS = 50;

interface Props {
  /** External events pushed in (e.g., from ScenarioPanel) */
  externalEvents?: FeedEvent[];
}

export function EventFeed({ externalEvents = [] }: Props) {
  const { engine, fundingRate, insuranceFund, loading } = useEngineState();
  const [events, setEvents]           = useState<FeedEvent[]>([]);
  const [newIds, setNewIds]           = useState<Set<string>>(new Set());
  const [activeFilters, setActiveFilters] = useState<Set<EventType>>(new Set(ALL_TYPES));
  const [showFilters, setShowFilters] = useState(false);
  const feedRef                        = useRef<HTMLDivElement>(null);

  const prevLiquidations  = useRef<bigint | null>(null);
  const prevInsuranceBal  = useRef<bigint | null>(null);
  const prevFundingSign   = useRef<number | null>(null);
  const initialized       = useRef(false);

  const addEvent = useCallback((ev: FeedEvent) => {
    setEvents((prev) => {
      if (prev.find((e) => e.id === ev.id)) return prev;
      return [ev, ...prev].slice(0, MAX_EVENTS);
    });
    setNewIds((prev) => new Set([...prev, ev.id]));
    setTimeout(() => setNewIds((prev) => { const n = new Set(prev); n.delete(ev.id); return n; }), 1200);
  }, []);

  // Inject external events (scenario events)
  useEffect(() => {
    externalEvents.forEach(addEvent);
  }, [externalEvents, addEvent]);

  // Derive events from engine state
  useEffect(() => {
    if (loading || !engine) return;

    if (!initialized.current) {
      prevLiquidations.current  = engine.lifetimeLiquidations ?? 0n;
      prevInsuranceBal.current  = insuranceFund?.balance ?? 0n;
      prevFundingSign.current   = fundingRate !== null ? Math.sign(Number(fundingRate)) : null;
      initialized.current = true;
      return;
    }

    // Liquidation events
    const liqs = engine.lifetimeLiquidations ?? 0n;
    if (prevLiquidations.current !== null && liqs > prevLiquidations.current) {
      const delta = liqs - prevLiquidations.current;
      addEvent({
        id:          `liq-${Date.now()}`,
        type:        "Liquidation",
        icon:        "⚠️",
        timestamp:   Date.now(),
        title:       `${delta} Liquidation${delta > 1n ? "s" : ""}`,
        description: `${delta} position${delta > 1n ? "s" : ""} fell below the maintenance margin and got liquidated.`,
        detail:      `When a position's margin ratio drops below the maintenance threshold, the protocol automatically closes it. Liquidators earn a fee for doing so, and any remaining deficit is covered by the insurance fund.`,
        color:       EVENT_CONFIG["Liquidation"].color,
      });
    }
    prevLiquidations.current = liqs;

    // Insurance fund changes
    const balance = insuranceFund?.balance ?? 0n;
    if (prevInsuranceBal.current !== null) {
      const delta = balance - prevInsuranceBal.current;
      if (delta < -1000n) {
        addEvent({
          id:          `ins-loss-${Date.now()}`,
          type:        "InsuranceEvent",
          icon:        "🛡️",
          timestamp:   Date.now(),
          title:       "Insurance Absorbed Loss",
          description: `Insurance fund covered ${formatUSDC(-delta)} of bad debt. Current balance: ${formatUSDC(balance)}.`,
          detail:      `Bad debt occurs when a liquidated position's losses exceed its collateral. The insurance fund steps in to cover the shortfall, protecting other traders from socialized losses.`,
          color:       EVENT_CONFIG["InsuranceEvent"].color,
        });
      } else if (delta > 10000n) {
        addEvent({
          id:          `ins-grow-${Date.now()}`,
          type:        "InsuranceEvent",
          icon:        "📥",
          timestamp:   Date.now(),
          title:       "Insurance Fund Grew",
          description: `+${formatUSDC(delta)} added to insurance fund. Current balance: ${formatUSDC(balance)}.`,
          color:       EVENT_CONFIG["InsuranceEvent"].color,
        });
      }
    }
    prevInsuranceBal.current = balance;

    // Funding rate direction change
    const sign = fundingRate !== null ? Math.sign(Number(fundingRate)) : null;
    if (sign !== null && prevFundingSign.current !== null && sign !== prevFundingSign.current) {
      addEvent({
        id:          `funding-flip-${Date.now()}`,
        type:        "FundingChange",
        icon:        "🔄",
        timestamp:   Date.now(),
        title:       "Funding Rate Flipped",
        description: sign > 0
          ? "Funding rate turned positive — longs now pay shorts."
          : "Funding rate turned negative — shorts now pay longs.",
        detail:      "Funding rate direction changes signal a shift in market sentiment. Positive = more longs, negative = more shorts.",
        color:       EVENT_CONFIG["FundingChange"].color,
      });
    }
    prevFundingSign.current = sign;
  }, [engine, fundingRate, insuranceFund, loading, addEvent]);

  // Auto-scroll to top when new event added
  useEffect(() => {
    if (feedRef.current && events.length > 0) {
      feedRef.current.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [events.length]);

  const toggleFilter = useCallback((type: EventType) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        if (next.size === 1) return prev; // keep at least one
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const filtered = events.filter((e) => activeFilters.has(e.type));

  return (
    <div className="rounded-none border border-white/10 bg-[var(--bg)]/80 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
            Event Feed
          </span>
          {events.length > 0 && (
            <span className="rounded-none border border-white/10 bg-white/5 px-1.5 py-0.5 text-[8px] font-bold tabular-nums text-[var(--text-dim)]">
              {filtered.length}
            </span>
          )}
          {/* Live indicator */}
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#4ade80] opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#4ade80]" />
          </span>
        </div>
        <button
          onClick={() => setShowFilters((v) => !v)}
          className="text-[9px] text-[var(--text-dim)] hover:text-[var(--text-secondary)] transition-colors"
        >
          {showFilters ? "Hide filters ▲" : "Filter ▼"}
        </button>
      </div>

      {/* Filter chips */}
      {showFilters && (
        <div className="flex flex-wrap gap-1 border-b border-white/10 px-3 py-2">
          {ALL_TYPES.map((type) => (
            <FilterChip
              key={type}
              type={type}
              active={activeFilters.has(type)}
              onToggle={toggleFilter}
            />
          ))}
        </div>
      )}

      {/* Feed */}
      <div
        ref={feedRef}
        className="max-h-[320px] overflow-y-auto overscroll-contain scroll-smooth"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.1) transparent" }}
      >
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <span className="mb-2 text-2xl opacity-30">📡</span>
            <p className="text-[9px] text-[var(--text-dim)]">
              Listening for market events...
            </p>
            <p className="mt-1 text-[8px] text-[var(--text-dim)]/60">
              Open a position or trigger a scenario to see events here.
            </p>
          </div>
        ) : (
          filtered.map((ev) => (
            <EventRow key={ev.id} event={ev} isNew={newIds.has(ev.id)} />
          ))
        )}
      </div>
    </div>
  );
}

/* ── Exported helper to push scenario events ─────────────── */
export function makeScenarioEvent(
  scenarioId: string,
  label: string,
  icon: string,
  type: "ScenarioStart" | "ScenarioEnd"
): FeedEvent {
  const cfg = EVENT_CONFIG[type];
  return {
    id:          `${type}-${scenarioId}-${Date.now()}`,
    type,
    icon:        type === "ScenarioStart" ? icon : "✅",
    timestamp:   Date.now(),
    title:       type === "ScenarioStart" ? `${label} Started` : `${label} Ended`,
    description: type === "ScenarioStart"
      ? `Market scenario "${label}" is now active. Watch how prices and liquidations react.`
      : `Market scenario "${label}" has completed. Check your positions and the insurance fund.`,
    color:       cfg.color,
  };
}
