"use client";

import { useState, useEffect, useRef } from "react";

export type EventType = "trade" | "liquidation" | "oracle" | "funding" | "system";

export interface SimulationEvent {
  id: string;
  timestamp: number;
  type: EventType;
  message: string;
}

const EVENT_COLORS: Record<EventType, string> = {
  trade: "var(--long)",
  liquidation: "var(--short)",
  oracle: "rgb(250, 204, 21)", // amber-400
  funding: "rgb(59, 130, 246)", // blue-500
  system: "var(--accent)",
};

const EVENT_LABELS: Record<EventType, string> = {
  trade: "TRADE",
  liquidation: "LIQ",
  oracle: "ORACLE",
  funding: "FUNDING",
  system: "SYSTEM",
};

// Mock event generator for demo
function generateMockEvent(): SimulationEvent {
  const types: EventType[] = ["trade", "liquidation", "oracle", "funding", "system"];
  const type = types[Math.floor(Math.random() * types.length)];
  
  const messages: Record<EventType, () => string> = {
    trade: () => {
      const bot = `Bot_${Math.floor(Math.random() * 20) + 1}`;
      const side = Math.random() > 0.5 ? "LONG" : "SHORT";
      const size = Math.floor(Math.random() * 1000) + 100;
      const price = (40 + Math.random() * 20).toFixed(2);
      return `${bot} opened ${side} ${size} @ $${price}`;
    },
    liquidation: () => {
      const bot = `Bot_${Math.floor(Math.random() * 20) + 1}`;
      const amount = (Math.random() * 5000 + 500).toFixed(0);
      return `${bot} LIQUIDATED — Insurance absorbed $${amount}`;
    },
    oracle: () => {
      const price = (40 + Math.random() * 20).toFixed(2);
      const change = (Math.random() * 10 - 5).toFixed(1);
      const sign = parseFloat(change) >= 0 ? "+" : "";
      return `Oracle price updated: $${price} (${sign}${change}%)`;
    },
    funding: () => {
      const oldRate = (Math.random() * 0.2 - 0.1).toFixed(3);
      const newRate = (Math.random() * 0.2 - 0.1).toFixed(3);
      const oldSign = parseFloat(oldRate) >= 0 ? "+" : "";
      const newSign = parseFloat(newRate) >= 0 ? "+" : "";
      return `Funding rate shifted: ${oldSign}${oldRate}% → ${newSign}${newRate}%`;
    },
    system: () => {
      const events = [
        "Insurance fund rebalanced",
        "Crank processed 45 accounts",
        "New trader account created",
        "Position margin adjusted",
        "Market parameters updated",
      ];
      return events[Math.floor(Math.random() * events.length)];
    },
  };
  
  return {
    id: `${Date.now()}-${Math.random()}`,
    timestamp: Date.now(),
    type,
    message: messages[type](),
  };
}

interface LiveEventFeedProps {
  isSimulationRunning: boolean;
}

export function LiveEventFeed({ isSimulationRunning }: LiveEventFeedProps) {
  const [events, setEvents] = useState<SimulationEvent[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Generate mock events when simulation is running
  useEffect(() => {
    if (!isSimulationRunning) {
      setEvents([]);
      return;
    }

    // Add initial event
    setEvents([{
      id: `start-${Date.now()}`,
      timestamp: Date.now(),
      type: "system",
      message: "Simulation started",
    }]);

    // Generate events every 2-5 seconds
    const interval = setInterval(() => {
      const newEvent = generateMockEvent();
      setEvents((prev) => {
        const updated = [...prev, newEvent];
        // Keep last 50 events
        return updated.slice(-50);
      });
    }, Math.random() * 3000 + 2000);

    return () => clearInterval(interval);
  }, [isSimulationRunning]);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (scrollRef.current && autoScrollRef.current && !isPaused) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, isPaused]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 10;
    
    autoScrollRef.current = isAtBottom;
  };

  if (!isSimulationRunning) {
    return (
      <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-6 text-center">
        <p className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Start simulation to view live events
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)]/30 px-3 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Live Event Feed
        </h3>
        
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-[var(--text-dim)] font-mono">
            {events.length} events
          </span>
          
          <button
            onClick={() => setIsPaused(!isPaused)}
            className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
          >
            {isPaused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>

      {/* Event List */}
      <div 
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-[400px] overflow-y-auto p-2 space-y-0.5 scroll-smooth"
      >
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-dim)]">
              Waiting for events...
            </p>
          </div>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className="flex items-start gap-2 rounded-none border border-[var(--border)]/20 bg-[var(--bg-elevated)]/50 px-2 py-1.5 hover:bg-[var(--bg-elevated)] transition-colors"
            >
              {/* Type Badge */}
              <div className="flex items-center gap-1 min-w-[70px]">
                <div 
                  className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: EVENT_COLORS[event.type] }}
                />
                <span 
                  className="text-[8px] font-bold uppercase tracking-[0.1em]"
                  style={{ color: EVENT_COLORS[event.type] }}
                >
                  {EVENT_LABELS[event.type]}
                </span>
              </div>

              {/* Message */}
              <p className="text-[9px] text-[var(--text)] font-mono flex-1 leading-tight">
                {event.message}
              </p>

              {/* Timestamp */}
              <span className="text-[8px] text-[var(--text-dim)] font-mono whitespace-nowrap">
                {new Date(event.timestamp).toLocaleTimeString('en-US', { 
                  hour: '2-digit', 
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false 
                })}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Auto-scroll indicator */}
      {!autoScrollRef.current && !isPaused && (
        <div className="border-t border-[var(--border)]/30 bg-[var(--bg-elevated)] px-3 py-1.5 text-center">
          <button
            onClick={() => {
              autoScrollRef.current = true;
              if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }
            }}
            className="text-[9px] uppercase tracking-[0.1em] text-[var(--accent)] hover:underline"
          >
            New events below — Click to scroll
          </button>
        </div>
      )}
    </div>
  );
}
