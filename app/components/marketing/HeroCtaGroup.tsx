"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

export function HeroCtaGroup() {
  const ref = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();

  useEffect(() => {
    if (prefersReduced || !ref.current) return;
    const btns = ref.current.querySelectorAll(".hero-cta");
    gsap.fromTo(
      btns,
      { opacity: 0, y: 16 },
      { opacity: 1, y: 0, duration: 0.4, stagger: 0.08, delay: 0.75, ease: "power2.out" }
    );
  }, [prefersReduced]);

  return (
    <div ref={ref} className="flex flex-wrap items-center gap-3">
      <Link
        href="/create"
        className={`hero-cta group relative inline-flex items-center gap-2 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.10] px-6 py-3 text-sm font-semibold text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.18] press ${prefersReduced ? '' : 'gsap-fade'}`}
      >
        Launch a Market
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform group-hover:translate-x-0.5"
        >
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </Link>

      <Link
        href="/markets"
        className={`hero-cta group inline-flex items-center gap-2 border-[1.5px] border-white/20 bg-white/[0.06] px-6 py-3 text-[15px] font-semibold text-white rounded-lg transition-all duration-150 hover:border-white/35 hover:bg-white/[0.10] ${prefersReduced ? '' : 'gsap-fade'}`}
      >
        Trade Now
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="transition-transform group-hover:translate-x-0.5"
        >
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </Link>

      <Link
        href="#how-it-works"
        className={`hero-cta inline-flex items-center gap-1 text-[14px] font-medium text-[var(--cyan)] border-b border-[var(--cyan)]/40 pb-px transition-colors hover:text-[var(--cyan)] hover:border-[var(--cyan)]/70 ${prefersReduced ? '' : 'gsap-fade'}`}
      >
        Earn as Creator <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}
