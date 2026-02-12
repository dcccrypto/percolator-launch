"use client";

import { useRef, useEffect, useState } from "react";
import gsap from "gsap";

interface AnimatedNumberProps {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  duration?: number;
  className?: string;
}

export function AnimatedNumber({
  value,
  prefix = "",
  suffix = "",
  decimals = 0,
  duration = 1.2,
  className = "",
}: AnimatedNumberProps) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const numRef = useRef({ val: 0 });
  const [prefersReduced, setPrefersReduced] = useState(false);

  useEffect(() => {
    setPrefersReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    if (!spanRef.current) return;
    if (prefersReduced) {
      spanRef.current.textContent = `${prefix}${value.toFixed(decimals)}${suffix}`;
      return;
    }

    gsap.to(numRef.current, {
      val: value,
      duration,
      ease: "power2.out",
      onUpdate: () => {
        if (spanRef.current) {
          const v = numRef.current.val;
          const formatted = decimals > 0 ? v.toFixed(decimals) : Math.round(v).toLocaleString();
          spanRef.current.textContent = `${prefix}${formatted}${suffix}`;
        }
      },
    });
  }, [value, prefix, suffix, decimals, duration, prefersReduced]);

  return (
    <span ref={spanRef} className={`font-[var(--font-jetbrains-mono)] tabular-nums ${className}`} style={{ willChange: 'contents' }}>
      {prefix}0{suffix}
    </span>
  );
}
