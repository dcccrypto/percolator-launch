"use client";

import { useState, useEffect, useCallback } from "react";
import { useEngineState } from "@/hooks/useEngineState";

interface ExplainerCard {
  id: string;
  icon: string;
  title: string;
  body: string;
  type: "info" | "warning" | "success";
  timestamp: number;
}

function getExplainerColor(type: ExplainerCard["type"]): string {
  return {
    info:    "border-[var(--accent)]/30 bg-[var(--accent)]/[0.04]",
    warning: "border-[var(--warning)]/30 bg-[var(--warning)]/[0.04]",
    success: "border-[var(--long)]/30 bg-[var(--long)]/[0.04]",
  }[type];
}

function getIconColor(type: ExplainerCard["type"]): string {
  return {
    info:    "text-[var(--accent)]",
    warning: "text-[var(--warning)]",
    success: "text-[var(--long)]",
  }[type];
}

function formatUSDC(lamports: bigint): string {
  const n = Number(lamports) / 1e6;
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function SimExplainer() {
  const { engine, fundingRate, insuranceFund, loading } = useEngineState();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [cards, setCards] = useState<ExplainerCard[]>([]);
  const [prevLiquidations, setPrevLiquidations] = useState<bigint | null>(null);
  const [prevInsuranceBalance, setPrevInsuranceBalance] = useState<bigint | null>(null);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => new Set([...prev, id]));
  }, []);

  useEffect(() => {
    if (loading || !engine) return;

    const newCards: ExplainerCard[] = [];

    // ── Funding rate explainer ──────────────────────────────────
    const rate = fundingRate !== null ? Number(fundingRate) : 0;
    if (Math.abs(rate) > 0) {
      const isPositive = rate > 0;
      const id = `funding-${isPositive ? "pos" : "neg"}`;
      newCards.push({
        id,
        icon: "💸",
        title: "Funding Rate Insight",
        body: isPositive
          ? `Funding rate is positive (+${(Math.abs(rate) * 9000 / 10000 / 100).toFixed(4)}%/hr) — longs are paying shorts. This means there are more longs than shorts, so longs pay a fee to keep the market balanced.`
          : `Funding rate is negative (${(Math.abs(rate) * 9000 / 10000 / 100).toFixed(4)}%/hr) — shorts are paying longs. There are more shorts than longs, so the rate incentivizes more longs to enter.`,
        type: "info",
        timestamp: Date.now(),
      });
    }

    // ── Liquidation happened ────────────────────────────────────
    const liqs = engine.lifetimeLiquidations ?? 0n;
    if (prevLiquidations !== null && liqs > prevLiquidations) {
      const newLiqs = liqs - prevLiquidations;
      newCards.push({
        id: `liq-${Date.now()}`,
        icon: "⚠️",
        title: `${newLiqs} Liquidation${newLiqs > 1n ? "s" : ""} Just Happened!`,
        body: `A position fell below the margin threshold. The protocol automatically closed it at the liquidation price. The liquidator earned a fee, and any remaining loss was absorbed by the insurance fund to protect other traders.`,
        type: "warning",
        timestamp: Date.now(),
      });
    }
    setPrevLiquidations(liqs);

    // ── Insurance fund absorbed loss ────────────────────────────
    const balance = insuranceFund?.balance ?? 0n;
    if (prevInsuranceBalance !== null && balance < prevInsuranceBalance) {
      const absorbed = prevInsuranceBalance - balance;
      newCards.push({
        id: `insurance-${Date.now()}`,
        icon: "🛡️",
        title: "Insurance Fund Absorbed a Loss",
        body: `The insurance fund absorbed ${formatUSDC(absorbed)} to cover bad debt from an under-margined liquidation. This protects profitable traders from socialized losses. Current fund balance: ${formatUSDC(balance)}.`,
        type: "warning",
        timestamp: Date.now(),
      });
    }
    setPrevInsuranceBalance(balance);

    // ── Healthy insurance fund ──────────────────────────────────
    const totalOI = Number(engine.totalOpenInterest ?? 0n) / 1e6;
    const insuranceBal = Number(balance) / 1e6;
    if (totalOI > 0 && insuranceBal > 0) {
      const ratio = insuranceBal / totalOI;
      if (ratio > 0.05) {
        newCards.push({
          id: "insurance-healthy",
          icon: "✅",
          title: "Insurance Fund is Healthy",
          body: `The insurance fund holds ${formatUSDC(balance)} (${(ratio * 100).toFixed(1)}% of total open interest). This is the safety net that covers bad debt when liquidations don't fully recover all losses.`,
          type: "success",
          timestamp: Date.now(),
        });
      }
    }

    // Merge, dedupe, keep only last 5 newest
    setCards((prev) => {
      const existing = prev.filter((c) => !dismissed.has(c.id));
      const allIds = new Set(existing.map((c) => c.id));
      const incoming = newCards.filter((c) => !allIds.has(c.id) && !dismissed.has(c.id));
      return [...incoming, ...existing].slice(0, 5);
    });
  }, [engine, fundingRate, insuranceFund, loading, dismissed, prevLiquidations, prevInsuranceBalance]);

  const visible = cards.filter((c) => !dismissed.has(c.id));
  if (visible.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/60">
        // CONTEXTUAL INSIGHTS
      </div>
      {visible.map((card) => (
        <div
          key={card.id}
          className={`relative rounded-none border p-3 transition-all duration-300 ${getExplainerColor(card.type)}`}
        >
          {/* Dismiss */}
          <button
            onClick={() => dismiss(card.id)}
            className="absolute right-2 top-2 text-[var(--text-dim)] transition-colors hover:text-[var(--text-secondary)]"
            aria-label="Dismiss"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>

          {/* Title */}
          <div className="mb-1.5 flex items-center gap-1.5 pr-5">
            <span className="text-sm">{card.icon}</span>
            <span className={`text-[10px] font-bold uppercase tracking-[0.1em] ${getIconColor(card.type)}`}>
              {card.title}
            </span>
          </div>

          {/* Body */}
          <p className="text-[10px] leading-relaxed text-[var(--text-secondary)]">{card.body}</p>
        </div>
      ))}
    </div>
  );
}
