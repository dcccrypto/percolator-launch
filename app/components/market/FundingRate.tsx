"use client";

import { FC, useRef, useEffect } from "react";
import gsap from "gsap";
import { useEngineState } from "@/hooks/useEngineState";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

export const FundingRate: FC = () => {
  const { fundingRate, engine, loading } = useEngineState();
  const annualizedRef = useRef<HTMLParagraphElement>(null);
  const prevAnnualizedRef = useRef<number | null>(null);
  const prefersReduced = usePrefersReducedMotion();

  const bpsPerSlot = Number(fundingRate ?? 0n);
  const hourlyRate = bpsPerSlot * 2.5 * 3600;
  const annualizedRate = bpsPerSlot * 2.5 * 3600 * 24 * 365;
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
          <p className={`text-sm font-medium ${rateColor}`}>{hourlyRate.toFixed(4)} bps</p>
        </div>
        <div>
          <p className="text-xs text-[var(--text-muted)]">Annualized</p>
          <p ref={annualizedRef} className={`text-lg font-bold ${rateColor}`}>{(annualizedRate / 100).toFixed(2)}%</p>
        </div>
      </div>
    </div>
  );
};
