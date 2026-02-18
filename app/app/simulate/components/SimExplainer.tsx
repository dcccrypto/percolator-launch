"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useEngineState } from "@/hooks/useEngineState";

interface ExplainerCard {
  id: string;
  icon: string;
  title: string;
  body: string;
  type: "info" | "warning" | "success" | "danger";
  timestamp: number;
  priority?: number; // higher = show first
}

function getCardStyle(type: ExplainerCard["type"]): { border: string; bg: string } {
  return {
    info:    { border: "border-[var(--accent)]/30",   bg: "bg-[var(--accent)]/[0.04]" },
    warning: { border: "border-[#facc15]/30",          bg: "bg-[#facc15]/[0.04]" },
    success: { border: "border-[#4ade80]/30",          bg: "bg-[#4ade80]/[0.04]" },
    danger:  { border: "border-[#ff4d6d]/30",          bg: "bg-[#ff4d6d]/[0.04]" },
  }[type];
}

function getTitleColor(type: ExplainerCard["type"]): string {
  return {
    info:    "text-[var(--accent)]",
    warning: "text-[#facc15]",
    success: "text-[#4ade80]",
    danger:  "text-[#ff4d6d]",
  }[type];
}

function formatUSDC(lamports: bigint): string {
  const n = Number(lamports) / 1e6;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatRate(bps: bigint): string {
  const r = Number(bps) / 10000;
  return `${r >= 0 ? "+" : ""}${(r * 100).toFixed(4)}%`;
}

interface AnimatedCardProps {
  card: ExplainerCard;
  onDismiss: (id: string) => void;
}

function AnimatedCard({ card, onDismiss }: AnimatedCardProps) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const t = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(t);
  }, []);

  const handleDismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => onDismiss(card.id), 250);
  }, [card.id, onDismiss]);

  const style = getCardStyle(card.type);

  return (
    <div
      className={`relative rounded-none border p-3 transition-all duration-300 ${style.border} ${style.bg}`}
      style={{
        opacity: visible && !exiting ? 1 : 0,
        transform: visible && !exiting ? "translateY(0)" : exiting ? "translateY(-4px)" : "translateY(8px)",
        transition: "opacity 0.25s ease, transform 0.25s ease",
      }}
    >
      {/* Dismiss */}
      <button
        onClick={handleDismiss}
        className="absolute right-2 top-2 text-[var(--text-dim)] transition-colors hover:text-[var(--text-secondary)]"
        aria-label="Dismiss"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      <div className="mb-1.5 flex items-center gap-1.5 pr-5">
        <span className="text-sm">{card.icon}</span>
        <span className={`text-[10px] font-bold uppercase tracking-[0.1em] ${getTitleColor(card.type)}`}>
          {card.title}
        </span>
      </div>

      <p className="text-[10px] leading-relaxed text-[var(--text-secondary)]">{card.body}</p>
    </div>
  );
}

const DISMISSED_KEY = "percolator_explainer_dismissed";

function loadDismissed(): Set<string> {
  try {
    const stored = localStorage.getItem(DISMISSED_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>) {
  try {
    // Only persist static IDs (not timestamped ones)
    const toStore = [...ids].filter(
      (id) => !id.includes("-16") && !id.includes("-17")
    );
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(toStore.slice(-20)));
  } catch {/* noop */}
}

export function SimExplainer() {
  const { engine, fundingRate, insuranceFund, totalOI, loading } = useEngineState();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [cards, setCards] = useState<ExplainerCard[]>([]);

  const prevLiquidations  = useRef<bigint | null>(null);
  const prevInsuranceBal  = useRef<bigint | null>(null);
  const prevFundingDir    = useRef<"pos" | "neg" | null>(null);
  const prevCrankSlot     = useRef<bigint | null>(null);
  const initialized       = useRef(false);

  // Load dismissed from localStorage on mount
  useEffect(() => {
    setDismissed(loadDismissed());
  }, []);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set([...prev, id]);
      saveDismissed(next);
      return next;
    });
  }, []);

  const pushCard = useCallback((card: ExplainerCard) => {
    setCards((prev) => {
      // Don't re-add same static ID
      if (prev.find((c) => c.id === card.id)) return prev;
      const sorted = [card, ...prev]
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      return sorted.slice(0, 6);
    });
  }, []);

  useEffect(() => {
    if (loading || !engine) return;

    // First run — set baselines without emitting cards
    if (!initialized.current) {
      prevLiquidations.current  = engine.lifetimeLiquidations ?? 0n;
      prevInsuranceBal.current  = insuranceFund?.balance ?? 0n;
      prevFundingDir.current    = fundingRate !== null
        ? (Number(fundingRate) >= 0 ? "pos" : "neg")
        : null;
      initialized.current = true;
      return;
    }

    // ── Funding rate ──────────────────────────────────────────────
    const rate = fundingRate !== null ? Number(fundingRate) : 0;
    const rateDir: "pos" | "neg" | null = fundingRate !== null
      ? (rate >= 0 ? "pos" : "neg")
      : null;

    const fundingId = `funding-${rateDir}`;
    if (rateDir && !dismissed.has(fundingId)) {
      const isPositive = rateDir === "pos";
      const formattedRate = formatRate(fundingRate!);
      pushCard({
        id: fundingId,
        icon: "💸",
        title: "Funding Rate Insight",
        body: isPositive
          ? `Funding rate is ${formattedRate}/hr — longs are paying shorts. There are more longs than shorts, so longs pay a fee to keep the market balanced. High rates incentivize shorts to enter.`
          : `Funding rate is ${formattedRate}/hr — shorts are paying longs. There are more shorts than longs, incentivising new longs to enter and rebalancing the market.`,
        type: "info",
        timestamp: Date.now(),
        priority: 2,
      });
    }

    // ── Funding direction changed ─────────────────────────────────
    if (rateDir && prevFundingDir.current && rateDir !== prevFundingDir.current) {
      const flipId = `funding-flip-${Date.now()}`;
      if (!dismissed.has(flipId)) {
        pushCard({
          id: flipId,
          icon: "🔄",
          title: "Funding Rate Flipped!",
          body: rateDir === "pos"
            ? `Funding just flipped positive — longs now pay shorts. Market sentiment shifted bullish with more longs entering.`
            : `Funding just flipped negative — shorts now pay longs. Selling pressure increased with more shorts dominating the market.`,
          type: "warning",
          timestamp: Date.now(),
          priority: 5,
        });
      }
    }
    prevFundingDir.current = rateDir;

    // ── Liquidation events ────────────────────────────────────────
    const liqs = engine.lifetimeLiquidations ?? 0n;
    if (prevLiquidations.current !== null && liqs > prevLiquidations.current) {
      const delta = liqs - prevLiquidations.current;
      const liqId = `liq-${Date.now()}`;
      pushCard({
        id: liqId,
        icon: "⚠️",
        title: `${delta} Position${delta > 1n ? "s" : ""} Liquidated`,
        body: `A position fell below the maintenance margin threshold. The protocol automatically closed it at the liquidation price. The liquidator earned a fee, and any remaining loss was absorbed by the insurance fund.`,
        type: "danger",
        timestamp: Date.now(),
        priority: 10,
      });
    }
    prevLiquidations.current = liqs;

    // ── Insurance fund absorbed loss ──────────────────────────────
    const balance = insuranceFund?.balance ?? 0n;
    if (prevInsuranceBal.current !== null && balance < prevInsuranceBal.current) {
      const absorbed = prevInsuranceBal.current - balance;
      const insId = `insurance-loss-${Date.now()}`;
      pushCard({
        id: insId,
        icon: "🛡️",
        title: "Insurance Fund Absorbed a Loss",
        body: `The insurance fund covered ${formatUSDC(absorbed)} of bad debt from an under-margined liquidation. Current fund: ${formatUSDC(balance)}. This protects profitable traders from socialized losses.`,
        type: "danger",
        timestamp: Date.now(),
        priority: 8,
      });
    }
    prevInsuranceBal.current = balance;

    // ── Insurance fund healthy ────────────────────────────────────
    const totalOINum = Number(totalOI ?? 0n) / 1e6;
    const insuranceBal = Number(balance) / 1e6;
    if (totalOINum > 0 && insuranceBal > 0) {
      const ratio = insuranceBal / totalOINum;
      const healthId = "insurance-healthy";
      if (ratio > 0.05 && !dismissed.has(healthId)) {
        pushCard({
          id: healthId,
          icon: "✅",
          title: "Insurance Fund is Healthy",
          body: `The insurance fund holds ${formatUSDC(balance)} (${(ratio * 100).toFixed(1)}% of open interest). A healthy fund means traders are protected from cascading liquidation losses.`,
          type: "success",
          timestamp: Date.now(),
          priority: 1,
        });
      } else if (ratio < 0.01 && !dismissed.has("insurance-low")) {
        // ── Insurance fund critically low ─────────────────────────
        pushCard({
          id: "insurance-low",
          icon: "🚨",
          title: "Insurance Fund Low!",
          body: `Insurance fund is only ${formatUSDC(balance)} (${(ratio * 100).toFixed(2)}% of OI). If depleted, losses get socialized across profitable traders via haircuts.`,
          type: "danger",
          timestamp: Date.now(),
          priority: 9,
        });
      }
    }

    // ── High open interest (absolute) ─────────────────────────────
    if (totalOINum > 500_000) {
      const oiId = `oi-high-${Math.floor(totalOINum / 100_000)}`;
      if (!dismissed.has(oiId)) {
        pushCard({
          id: oiId,
          icon: "📊",
          title: `High Open Interest: ${formatUSDC(totalOI ?? 0n)}`,
          body: `Open interest is elevated at ${formatUSDC(totalOI ?? 0n)}. Large OI means more exposure for the insurance fund if a cascade occurs. Watch margin ratios carefully.`,
          type: totalOINum > 1_000_000 ? "danger" : "warning",
          timestamp: Date.now(),
          priority: 6,
        });
      }
    }

    // ── Crank staleness ───────────────────────────────────────────
    const currentSlot = engine.lastCrankSlot ?? null;
    if (currentSlot !== null && prevCrankSlot.current !== null) {
      const slotDelta = Number(currentSlot - prevCrankSlot.current);
      // ~0.4s per slot; warn if >60 slots stale (~24 seconds)
      if (slotDelta < 0) {
        const staleId = `crank-stale-${Math.floor(Date.now() / 30000)}`;
        if (!dismissed.has(staleId)) {
          pushCard({
            id: staleId,
            icon: "⏱️",
            title: "Markets Haven't Been Cranked Recently",
            body: `The crank hasn't processed this market in ~${Math.abs(slotDelta)} slots. Funding rates and PnL calculations may be stale. Crank keepers should be running to keep markets accurate.`,
            type: "warning",
            timestamp: Date.now(),
            priority: 7,
          });
        }
      }
    }
    if (currentSlot !== null) prevCrankSlot.current = currentSlot;
  }, [engine, fundingRate, insuranceFund, totalOI, loading, dismissed, pushCard]);

  const visible = cards.filter((c) => !dismissed.has(c.id));
  if (visible.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/60">
        // Contextual Insights
      </div>
      {visible.map((card) => (
        <AnimatedCard key={card.id} card={card} onDismiss={dismiss} />
      ))}
    </div>
  );
}
