"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

interface HeroStatsProps {
  markets: number;
  volume: number;
  traders: number;
  isDevnet?: boolean;
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

export function HeroStats({
  markets,
  volume,
  traders,
  isDevnet = true,
}: HeroStatsProps) {
  const ref = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  useEffect(() => {
    if (prefersReduced || !ref.current) return;
    gsap.fromTo(
      ref.current,
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.4, delay: 0.65, ease: "power2.out" }
    );
  }, [prefersReduced]);

  const stats = [
    {
      label: "Volume 24h",
      value: <span className="font-semibold text-white">{formatVolume(volume)}{isDevnet && <span className="ml-1 text-white/25">(devnet)</span>}</span>,
    },
    {
      label: "Markets",
      value: <AnimatedNumber value={markets} duration={1.2} className="font-semibold text-white" />,
    },
    {
      label: "Traders",
      value: <AnimatedNumber value={traders} duration={1.2} className="font-semibold text-white" />,
    },
    {
      label: "Fills",
      value: <span className="font-semibold text-white">&lt; 400ms</span>,
    },
  ];

  return (
    <div
      ref={ref}
      className="gsap-fade grid grid-cols-2 gap-x-6 gap-y-2 md:flex md:flex-wrap md:items-center"
      style={{ fontFamily: "var(--font-heading)" }}
    >
      {stats.map((s, i) => (
        <div key={s.label} className="flex items-center gap-2 text-[13px] font-medium tracking-[0.01em]">
          {i > 0 && (
            <span className="mr-2 hidden text-white/10 md:inline">|</span>
          )}
          <span className="text-[#9ca3af]">{s.label}</span>
          {s.value}
        </div>
      ))}
    </div>
  );
}
