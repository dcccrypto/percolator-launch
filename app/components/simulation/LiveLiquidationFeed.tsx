"use client";

import { FC, useEffect, useRef, useState } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useEngineState } from "@/hooks/useEngineState";

interface LiqEvent {
  id: string;
  timestamp: number;
  accountIdx: number;
  type: "liquidation" | "force_close";
}

/**
 * Shows real-time liquidation + force-close events by diffing on-chain
 * lifetime counters each poll cycle.
 */
export const LiveLiquidationFeed: FC = () => {
  const { engine, loading } = useEngineState();
  const { accounts } = useSlabState();
  const [events, setEvents] = useState<LiqEvent[]>([]);
  const prevLiqs = useRef<bigint>(0n);
  const prevForce = useRef<bigint>(0n);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!engine) return;

    const liqs = engine.lifetimeLiquidations;
    const force = engine.lifetimeForceCloses;

    // Detect new liquidations
    if (prevLiqs.current > 0n && liqs > prevLiqs.current) {
      const count = Number(liqs - prevLiqs.current);
      const newEvents: LiqEvent[] = Array.from({ length: count }, (_, i) => ({
        id: `liq-${Date.now()}-${i}`,
        timestamp: Date.now(),
        accountIdx: -1,
        type: "liquidation" as const,
      }));
      setEvents(prev => [...prev, ...newEvents].slice(-50));
    }

    // Detect new force closes
    if (prevForce.current > 0n && force > prevForce.current) {
      const count = Number(force - prevForce.current);
      const newEvents: LiqEvent[] = Array.from({ length: count }, (_, i) => ({
        id: `fc-${Date.now()}-${i}`,
        timestamp: Date.now(),
        accountIdx: -1,
        type: "force_close" as const,
      }));
      setEvents(prev => [...prev, ...newEvents].slice(-50));
    }

    prevLiqs.current = liqs;
    prevForce.current = force;
  }, [engine]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  if (loading || !engine) {
    return (
      <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <span className="text-[10px] text-[var(--text-dim)]">Loading...</span>
      </div>
    );
  }

  const lifetimeLiqs = Number(engine.lifetimeLiquidations);
  const lifetimeForce = Number(engine.lifetimeForceCloses);
  const insuranceBalance = Number(engine.insuranceFund?.balance ?? 0n);

  return (
    <div className="border border-[var(--border)]/50 bg-[var(--bg)]/80">
      <div className="flex items-center justify-between border-b border-[var(--border)]/30 px-3 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Liquidation Feed
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-[9px] font-mono text-[var(--text-dim)]">
            {lifetimeLiqs} liqs / {lifetimeForce} force
          </span>
          {lifetimeLiqs > 0 && (
            <div className="h-2 w-2 animate-pulse" style={{ backgroundColor: "var(--short)" }} />
          )}
        </div>
      </div>

      {/* Lifetime counters */}
      <div className="grid grid-cols-3 gap-px border-b border-[var(--border)]/30">
        <div className="p-2">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Liquidations</p>
          <p className="text-[14px] font-bold font-mono" style={{ color: lifetimeLiqs > 0 ? "var(--short)" : "var(--text)" }}>
            {lifetimeLiqs}
          </p>
        </div>
        <div className="p-2">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Force Closes</p>
          <p className="text-[14px] font-bold font-mono" style={{ color: lifetimeForce > 0 ? "var(--short)" : "var(--text)" }}>
            {lifetimeForce}
          </p>
        </div>
        <div className="p-2">
          <p className="text-[8px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Insurance</p>
          <p className="text-[14px] font-bold font-mono text-[var(--accent)]">
            {insuranceBalance > 1e6 ? `${(insuranceBalance / 1e6).toFixed(1)}M` : insuranceBalance > 1e3 ? `${(insuranceBalance / 1e3).toFixed(1)}K` : insuranceBalance.toFixed(0)}
          </p>
        </div>
      </div>

      {/* Live event stream */}
      <div ref={scrollRef} className="h-[160px] overflow-y-auto p-2 space-y-0.5">
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              {lifetimeLiqs === 0 ? "No liquidation events yet" : "Watching for new events..."}
            </p>
          </div>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className="flex items-center gap-2 border border-[var(--border)]/20 bg-[var(--bg-elevated)]/50 px-2 py-1.5"
            >
              <div className="h-1.5 w-1.5" style={{ backgroundColor: event.type === "liquidation" ? "var(--short)" : "var(--warning)" }} />
              <span className="text-[8px] font-bold uppercase tracking-[0.1em]" style={{ color: event.type === "liquidation" ? "var(--short)" : "var(--warning)" }}>
                {event.type === "liquidation" ? "LIQ" : "FORCE"}
              </span>
              <span className="text-[9px] font-mono text-[var(--text)] flex-1">
                {event.type === "liquidation" ? "Position liquidated — insurance absorbed loss" : "Position force-closed by engine"}
              </span>
              <span className="text-[8px] text-[var(--text-dim)] font-mono">
                {new Date(event.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
