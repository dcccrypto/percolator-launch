"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useEngineState } from "@/hooks/useEngineState";

const DISMISSED_KEY = "percolator_concept_dismissed";

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
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-30)));
  } catch {/* noop */}
}

/* ── Concept definitions ─────────────────────────────────── */
interface Concept {
  id: string;
  icon: string;
  title: string;
  summary: string;
  detail: string;
  learnMore: string;
  triggerCondition?: string; // description of when this is shown
  color: string;
  borderColor: string;
}

const CONCEPTS: Concept[] = [
  {
    id: "funding-rates",
    icon: "💸",
    title: "Funding Rates",
    summary:
      "Funding rates are periodic payments that balance longs and shorts. When longs dominate, longs pay shorts — and vice versa.",
    detail:
      "Funding rates exist to keep the perpetual contract price anchored to the underlying asset (index) price. If too many traders are long, the perp would trade above the index, so longs pay shorts to incentivise more shorts. The rate is calculated based on the difference in open interest between longs and shorts, multiplied by a sensitivity parameter. Rates are applied every time the crank processes the market (usually every slot or few slots).",
    learnMore:
      "In traditional markets, futures converge to spot at expiry. Perpetuals have no expiry, so funding rates serve as a synthetic convergence mechanism. High funding = crowded trade. Low/negative funding = mean-reversion opportunity.",
    triggerCondition: "Shown when funding rate is non-zero",
    color: "text-[var(--accent)]",
    borderColor: "border-[var(--accent)]/30",
  },
  {
    id: "liquidations",
    icon: "⚠️",
    title: "Liquidations",
    summary:
      "When your margin falls below the maintenance level, your position is force-closed to protect the protocol from bad debt.",
    detail:
      "Each position requires an initial margin (e.g. 10% for 10x leverage) and a maintenance margin (e.g. 5%). If losses erode your margin below maintenance, the protocol liquidates your position automatically. A liquidator (anyone running the keeper bot) executes the close and earns a liquidation fee. Any remaining shortfall beyond your collateral is covered by the insurance fund.",
    learnMore:
      "Cascade liquidations happen when a large liquidation moves the price further, which liquidates more positions. This can deplete the insurance fund rapidly in a black-swan event. Percolator mitigates this with max open-interest caps and PnL warmup periods.",
    triggerCondition: "Shown when a liquidation occurs",
    color: "text-[#ff4d6d]",
    borderColor: "border-[#ff4d6d]/30",
  },
  {
    id: "insurance-fund",
    icon: "🛡️",
    title: "Insurance Fund",
    summary:
      "The insurance fund covers losses when liquidations don't fully recover bad debt, protecting profitable traders.",
    detail:
      "The insurance fund accumulates a portion of trading fees and liquidation fees. When a liquidation is underwater (the position's losses exceed its collateral), the insurance fund absorbs the difference. If the fund is depleted, the protocol enters a 'haircut' mode where profitable traders absorb a proportional share of remaining losses — a last resort.",
    learnMore:
      "A healthy insurance fund (>5% of OI) is a sign of a well-capitalised market. Watch the fund during Flash Crash and Black Swan scenarios — you'll see it deplete in real time as bad debt accumulates. Rebuild it by increasing trading volume (fees flow in).",
    triggerCondition: "Shown when insurance fund changes or is low",
    color: "text-[#a78bfa]",
    borderColor: "border-[#a78bfa]/30",
  },
  {
    id: "open-interest",
    icon: "📊",
    title: "Open Interest",
    summary:
      "Open interest is the total value of all open positions. It measures market activity and affects capacity, funding, and risk.",
    detail:
      "Open interest (OI) is the sum of all long + short position sizes. High OI means the market is heavily utilised — this can restrict new positions if OI limits are reached. OI imbalance (more longs than shorts or vice versa) drives the funding rate. Total OI also determines how much insurance fund coverage is needed.",
    learnMore:
      "OI caps exist to limit systemic risk. If OI is at 90%+ capacity, the market may reject new positions or apply higher fees. In the simulation, trigger a Gentle Trend scenario and watch OI grow as traders pile in on one side.",
    triggerCondition: "Shown when OI is high",
    color: "text-[#38bdf8]",
    borderColor: "border-[#38bdf8]/30",
  },
  {
    id: "pnl-warmup",
    icon: "🔥",
    title: "PnL Warmup",
    summary:
      "New positions have a warmup period before full PnL counts. This prevents oracle manipulation attacks.",
    detail:
      "PnL warmup (also called the oracle attack buffer) requires new positions to 'age' before their full profit can be withdrawn. During warmup, your realised PnL is discounted. This prevents flash-loan style attacks where a trader manipulates the oracle price, opens a massive position, takes profit, and exits before the price corrects.",
    learnMore:
      "Without PnL warmup, a sophisticated attacker could: 1) Borrow a huge amount, 2) Push the oracle price, 3) Open a leveraged position, 4) Exit at manipulated price, 5) Repay loan and keep profit. The warmup period makes this attack economically unviable.",
    triggerCondition: "Always shown as an educational card",
    color: "text-[#fb923c]",
    borderColor: "border-[#fb923c]/30",
  },
];

/* ── Card component ──────────────────────────────────────── */
interface ConceptCardProps {
  concept: Concept;
  onDismiss: (id: string) => void;
}

function ConceptCard({ concept, onDismiss }: ConceptCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [learnMore, setLearnMore] = useState(false);
  const [entering, setEntering] = useState(true);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const t = requestAnimationFrame(() => setEntering(false));
    return () => cancelAnimationFrame(t);
  }, []);

  const handleDismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => onDismiss(concept.id), 250);
  }, [concept.id, onDismiss]);

  return (
    <div
      className={`relative border ${concept.borderColor} bg-white/[0.02] backdrop-blur-sm transition-all duration-300 overflow-hidden`}
      style={{
        opacity: entering || exiting ? 0 : 1,
        transform: entering ? "translateY(6px)" : exiting ? "translateY(-4px)" : "translateY(0)",
        transition: "opacity 0.25s ease, transform 0.25s ease",
      }}
    >
      {/* Dismiss */}
      <button
        onClick={handleDismiss}
        className="absolute right-2.5 top-2.5 text-[var(--text-dim)] hover:text-[var(--text-secondary)] transition-colors z-10"
        aria-label="Dismiss card"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      <div className="p-3 pr-7">
        {/* Header */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 w-full text-left group"
        >
          <span className="text-base leading-none">{concept.icon}</span>
          <div className="flex-1 min-w-0">
            <span className={`text-[10px] font-bold uppercase tracking-[0.12em] ${concept.color}`}>
              {concept.title}
            </span>
          </div>
          <span className="text-[8px] text-[var(--text-dim)] group-hover:text-[var(--text-secondary)] shrink-0 transition-colors">
            {expanded ? "▲" : "▼"}
          </span>
        </button>

        {/* Summary — always visible */}
        <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--text-secondary)]">
          {concept.summary}
        </p>

        {/* Expanded detail */}
        {expanded && (
          <div className="mt-2 space-y-2" style={{ animation: "expandFade 0.2s ease" }}>
            <p className="text-[9px] leading-relaxed text-[var(--text-secondary)]">
              {concept.detail}
            </p>

            <button
              onClick={() => setLearnMore((v) => !v)}
              className={`text-[9px] font-medium transition-colors ${concept.color} opacity-70 hover:opacity-100`}
            >
              {learnMore ? "▲ Less" : "💡 Learn More"}
            </button>

            {learnMore && (
              <div
                className={`mt-1.5 rounded-none border ${concept.borderColor} bg-white/[0.03] p-2.5`}
                style={{ animation: "expandFade 0.2s ease" }}
              >
                <p className="text-[9px] leading-relaxed text-[var(--text-secondary)]">
                  {concept.learnMore}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom accent line */}
      <div
        className="h-[1px] w-full"
        style={{
          background: `linear-gradient(90deg, transparent, ${concept.borderColor.replace("border-", "").replace("/30", "")} 50%, transparent)`,
          opacity: 0.3,
        }}
      />

      <style>{`
        @keyframes expandFade {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

/* ── Main component ──────────────────────────────────────── */
interface Props {
  /** Override which concepts are visible (e.g., from scenario context) */
  forcedConcepts?: string[];
  className?: string;
}

export function RiskConceptCards({ forcedConcepts, className }: Props) {
  const { engine, fundingRate, insuranceFund, totalOI, loading } = useEngineState();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [visible, setVisible]     = useState<Set<string>>(new Set());
  const initialized               = useRef(false);

  useEffect(() => {
    setDismissed(loadDismissed());
    // PnL warmup is always shown on first load
    setVisible(new Set(["pnl-warmup"]));
  }, []);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set([...prev, id]);
      saveDismissed(next);
      return next;
    });
  }, []);

  const showCard = useCallback((id: string) => {
    setVisible((prev) => {
      if (prev.has(id)) return prev;
      return new Set([...prev, id]);
    });
  }, []);

  // Contextual triggers from engine state
  useEffect(() => {
    if (loading || !engine) return;

    if (!initialized.current) {
      initialized.current = true;
      return;
    }

    // Funding rate non-zero → show funding card
    if (fundingRate !== null && Number(fundingRate) !== 0) {
      showCard("funding-rates");
    }

    // Liquidation happened → show liquidations card
    const liqs = engine.lifetimeLiquidations ?? 0n;
    if (liqs > 0n) {
      showCard("liquidations");
    }

    // Insurance fund changed → show insurance card
    if (insuranceFund?.balance !== undefined) {
      const bal = Number(insuranceFund.balance) / 1e6;
      const oi  = Number(totalOI ?? 0n) / 1e6;
      if (oi > 0 && bal / oi < 0.03) {
        showCard("insurance-fund");
      }
    }

    // High OI (absolute) → show OI card
    const curOI = Number(totalOI ?? 0n) / 1e6;
    if (curOI > 50_000) {
      showCard("open-interest");
    }
  }, [engine, fundingRate, insuranceFund, totalOI, loading, showCard]);

  // Forced concepts (from scenario or parent)
  useEffect(() => {
    if (forcedConcepts) {
      forcedConcepts.forEach((id) => showCard(id));
    }
  }, [forcedConcepts, showCard]);

  const visibleConcepts = CONCEPTS.filter(
    (c) => visible.has(c.id) && !dismissed.has(c.id)
  );

  if (visibleConcepts.length === 0) return null;

  return (
    <div className={className}>
      <div className="mb-2 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--accent)]/60">
        // Risk Concepts
      </div>
      <div className="space-y-2">
        {visibleConcepts.map((concept) => (
          <ConceptCard key={concept.id} concept={concept} onDismiss={dismiss} />
        ))}
      </div>
    </div>
  );
}

/* ── Standalone concept lookup (for use in other components) */
export function getConceptById(id: string): Concept | undefined {
  return CONCEPTS.find((c) => c.id === id);
}

export { CONCEPTS };
export type { Concept };
