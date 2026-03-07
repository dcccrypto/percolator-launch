"use client";

import { FC, useRef, useEffect } from "react";
import gsap from "gsap";
import { useEngineState } from "@/hooks/useEngineState";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { sanitizeFundingRateBps } from "@/lib/health";

export const FundingRate: FC = () => {
  const { fundingRate, engine, loading } = useEngineState();
  const annualizedRef = useRef<HTMLParagraphElement>(null);
  const prevAnnualizedRef = useRef<number | null>(null);
  const prefersReduced = usePrefersReducedMotion();

  // sanitizeFundingRateBps: clamp to valid on-chain range [-10_000, 10_000] bps/slot.
  // Values outside this range are garbage (wrong offset / uninit slab) — show zero.
  const sanitized = sanitizeFundingRateBps(fundingRate);
  const bpsPerSlot = sanitized !== null ? Number(sanitized) : 0;
  // Slots ≈ 400ms → 9000 slots/hr; divide by 100 to convert bps → %
  const hourlyRate = (bpsPerSlot * 9000) / 10000;
  const annualizedRate = hourlyRate * 24 * 365;
  const rateColor = bpsPerSlot === 0 ? "text-[var(--text-muted)]" : bpsPerSlot > 0 ? "text-[var(--long)]" : "text-[var(--short)]";

  useEffect(() => {
    if (
      annualizedRef.current &&
      !prefersReduced &&
      prevAnnualizedRef.current !== null &&
      prevAnnualizedRef.current !== annualizedRate
    ) {
      gsap.fromTo(
        annualizedRef.current,
        { scale: 1.05, filter: "brightness(1.5)" },
        { scale: 1, filter: "brightness(1)", duration: 0.4, ease: "power2.out" },
      );
    }
    prevAnnualizedRef.current = annualizedRate;
  }, [annualizedRate, prefersReduced]);

  if (loading || !engine) {
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-6">
        <p className="text-[var(--text-muted)]">Loading...</p>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-6">
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[var(--text-muted)]">Funding Rate</h3>
      <div className="space-y-2">
        <div>
          <p className="text-xs text-[var(--text-muted)]">Per Slot</p>
          <p className={`text-sm font-medium ${rateColor}`}>{bpsPerSlot.toFixed(6)} bps</p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">Hourly</p>
          <p className={`text-sm font-medium ${rateColor}`}>{hourlyRate >= 0 ? "+" : ""}{hourlyRate.toFixed(4)}%/hr</p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">Annualized</p>
          <p ref={annualizedRef} className={`text-lg font-bold ${rateColor}`}>{annualizedRate >= 0 ? "+" : ""}{annualizedRate.toFixed(2)}%</p>
        </div>
      </div>
    </div>
  );
};
