"use client";

import { useState, useEffect, useCallback, useRef } from "react";

const TOUR_STORAGE_KEY = "percolator_tour_completed";
const TOUR_STEP_KEY    = "percolator_tour_step";

interface WalkthroughStep {
  id: string;
  step: number;
  title: string;
  description: string;
  icon: string;
  targetSelector?: string;  // CSS selector to highlight
  position?: "top" | "bottom" | "left" | "right";
  action?: string;           // CTA label
}

const STEPS: WalkthroughStep[] = [
  {
    id: "connect-wallet",
    step: 1,
    title: "Connect Your Wallet",
    description:
      "Start by connecting a Solana wallet (Phantom, Backpack, etc). On devnet, all assets are simulated — no real money needed.",
    icon: "👛",
    targetSelector: "[data-tour='wallet-button']",
    position: "bottom",
    action: "Connect wallet →",
  },
  {
    id: "get-simusdc",
    step: 2,
    title: "Get simUSDC",
    description:
      "Claim free simUSDC from the faucet to use as collateral. This is play money on devnet — experiment freely with zero risk.",
    icon: "💵",
    targetSelector: "[data-tour='deposit-card']",
    position: "right",
    action: "Get simUSDC →",
  },
  {
    id: "open-position",
    step: 3,
    title: "Open a Position",
    description:
      "Use the trade form to go Long or Short. Choose your leverage (1x–20x). Higher leverage = higher potential gains AND higher liquidation risk.",
    icon: "📋",
    targetSelector: "[data-tour='trade-form']",
    position: "right",
    action: "Open a position →",
  },
  {
    id: "watch-funding",
    step: 4,
    title: "Watch Funding Rates",
    description:
      "Funding rates balance longs and shorts. If there are more longs, longs pay shorts (positive rate). If more shorts, shorts pay longs. Rates update every crank cycle.",
    icon: "💸",
    targetSelector: "[data-tour='risk-dashboard']",
    position: "left",
    action: "Check funding →",
  },
  {
    id: "understand-liquidations",
    step: 5,
    title: "Understand Liquidations",
    description:
      "When your margin falls below the maintenance level, your position gets liquidated. The liquidator closes it and earns a fee. Watch the Risk Dashboard to monitor your margin ratio.",
    icon: "⚠️",
    targetSelector: "[data-tour='risk-dashboard']",
    position: "left",
    action: "Got it →",
  },
  {
    id: "insurance-fund",
    step: 6,
    title: "The Insurance Fund",
    description:
      "The insurance fund absorbs bad debt when liquidations don't fully cover losses. It grows from trading fees. If it's depleted, losses get socialized — a mechanism called 'haircuts'.",
    icon: "🛡️",
    targetSelector: "[data-tour='risk-dashboard']",
    position: "left",
    action: "Understood →",
  },
  {
    id: "try-scenario",
    step: 7,
    title: "Try a Market Scenario",
    description:
      "Vote for a scenario in the Scenarios panel. Flash Crash drops the price 30%, Short Squeeze spikes it up, Black Swan is extreme stress. Watch how your position and the insurance fund react!",
    icon: "🎭",
    targetSelector: "[data-tour='scenario-panel']",
    position: "left",
    action: "Start exploring! 🚀",
  },
];

const TOTAL_STEPS = STEPS.length;

interface HighlightBoxProps {
  targetSelector: string | undefined;
}

function HighlightBox({ targetSelector }: HighlightBoxProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!targetSelector) { setRect(null); return; }
    const el = document.querySelector(targetSelector) as HTMLElement | null;
    if (!el) { setRect(null); return; }
    const r = el.getBoundingClientRect();
    setRect(r);
    const observer = new ResizeObserver(() => {
      const updated = el.getBoundingClientRect();
      setRect(updated);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [targetSelector]);

  if (!rect) return null;

  const PADDING = 6;
  return (
    <div
      className="pointer-events-none fixed z-[9998] rounded-sm border-2 border-[var(--accent)] animate-pulse"
      style={{
        top:    rect.top    - PADDING + window.scrollY,
        left:   rect.left   - PADDING,
        width:  rect.width  + PADDING * 2,
        height: rect.height + PADDING * 2,
        boxShadow: "0 0 0 9999px rgba(0,0,0,0.5), 0 0 20px rgba(var(--accent-rgb, 139, 92, 246), 0.4)",
      }}
    />
  );
}

interface TooltipProps {
  step: WalkthroughStep;
  currentStep: number;
  totalSteps: number;
  onNext: () => void;
  onSkip: () => void;
  onBack: () => void;
}

function Tooltip({ step, currentStep, totalSteps, onNext, onSkip, onBack }: TooltipProps) {
  const isLast = currentStep === totalSteps;
  return (
    <div
      className="fixed z-[9999] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[340px] max-w-[90vw]"
      style={{ animation: "fadeInScale 0.2s ease" }}
    >
      <div className="border border-[var(--accent)]/30 bg-[#0a0a0f]/95 backdrop-blur-md shadow-2xl">
        {/* Progress bar */}
        <div className="h-0.5 bg-white/5">
          <div
            className="h-full bg-[var(--accent)] transition-all duration-500"
            style={{ width: `${(currentStep / totalSteps) * 100}%` }}
          />
        </div>

        <div className="p-5">
          {/* Step indicator */}
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-[var(--accent)]/70">
              Step {currentStep} of {totalSteps}
            </span>
            <button
              onClick={onSkip}
              className="text-[9px] text-[var(--text-dim)] hover:text-[var(--text-secondary)] transition-colors"
            >
              Skip tour ×
            </button>
          </div>

          {/* Content */}
          <div className="mb-4 flex gap-3">
            <span className="text-3xl leading-none mt-0.5">{step.icon}</span>
            <div>
              <h3 className="mb-1.5 text-sm font-bold text-[var(--text)]">{step.title}</h3>
              <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                {step.description}
              </p>
            </div>
          </div>

          {/* Dot indicators */}
          <div className="mb-4 flex items-center justify-center gap-1">
            {Array.from({ length: totalSteps }, (_, i) => (
              <div
                key={i}
                className="h-1 rounded-full transition-all duration-300"
                style={{
                  width: i + 1 === currentStep ? "16px" : "6px",
                  backgroundColor: i + 1 <= currentStep ? "var(--accent)" : "rgba(255,255,255,0.15)",
                }}
              />
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            {currentStep > 1 && (
              <button
                onClick={onBack}
                className="border border-white/10 px-3 py-1.5 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors"
              >
                ← Back
              </button>
            )}
            <button
              onClick={onNext}
              className="flex-1 border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] hover:bg-[var(--accent)]/20 transition-all"
            >
              {isLast ? "🚀 Start Exploring!" : step.action ?? "Next →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface Props {
  /** If true, auto-start tour on first visit */
  autoStart?: boolean;
  /** Expose a ref so parent can trigger the tour */
  onTourComplete?: () => void;
}

export function GuidedWalkthrough({ autoStart = true, onTourComplete }: Props) {
  const [active, setActive]           = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const mounted                        = useRef(false);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    try {
      const completed = localStorage.getItem(TOUR_STORAGE_KEY);
      if (!completed && autoStart) {
        const saved = parseInt(localStorage.getItem(TOUR_STEP_KEY) ?? "1", 10);
        setCurrentStep(isNaN(saved) ? 1 : Math.min(saved, TOTAL_STEPS));
        setActive(true);
      }
    } catch {/* noop */}
  }, [autoStart]);

  // Expose a way to re-open the tour (e.g. via "?" button)
  useEffect(() => {
    const handler = () => {
      setCurrentStep(1);
      setActive(true);
    };
    window.addEventListener("percolator:openTour", handler);
    return () => window.removeEventListener("percolator:openTour", handler);
  }, []);

  const handleNext = useCallback(() => {
    if (currentStep >= TOTAL_STEPS) {
      handleSkip();
      return;
    }
    const next = currentStep + 1;
    setCurrentStep(next);
    try { localStorage.setItem(TOUR_STEP_KEY, String(next)); } catch {/* noop */}
  }, [currentStep]);

  const handleBack = useCallback(() => {
    if (currentStep <= 1) return;
    const prev = currentStep - 1;
    setCurrentStep(prev);
    try { localStorage.setItem(TOUR_STEP_KEY, String(prev)); } catch {/* noop */}
  }, [currentStep]);

  const handleSkip = useCallback(() => {
    setActive(false);
    try {
      localStorage.setItem(TOUR_STORAGE_KEY, "true");
      localStorage.removeItem(TOUR_STEP_KEY);
    } catch {/* noop */}
    onTourComplete?.();
  }, [onTourComplete]);

  if (!active) return null;

  const step = STEPS[currentStep - 1];

  return (
    <>
      {/* Backdrop handled by HighlightBox box-shadow trick */}
      <HighlightBox targetSelector={step?.targetSelector} />
      <Tooltip
        step={step}
        currentStep={currentStep}
        totalSteps={TOTAL_STEPS}
        onNext={handleNext}
        onBack={handleBack}
        onSkip={handleSkip}
      />
      {/* Keyframe styles */}
      <style>{`
        @keyframes fadeInScale {
          from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
      `}</style>
    </>
  );
}

/** Small help button that re-opens the tour */
export function TourHelpButton() {
  const handleClick = useCallback(() => {
    window.dispatchEvent(new Event("percolator:openTour"));
  }, []);

  return (
    <button
      onClick={handleClick}
      title="Open guided walkthrough"
      className="flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[11px] font-bold text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--accent)] transition-all"
    >
      ?
    </button>
  );
}
