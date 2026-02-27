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
        className={`hero-cta group relative inline-flex items-center gap-2 rounded-xl bg-purple-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-purple-500 ${prefersReduced ? '' : 'gsap-fade'}`}
        style={{
          boxShadow:
            "0 0 20px rgba(124,58,237,0.4), 0 0 60px rgba(124,58,237,0.15)",
        }}
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
        className={`hero-cta group inline-flex items-center gap-2 rounded-xl border-[1.5px] border-green-400/30 bg-green-500/15 px-6 py-3 text-[15px] font-semibold text-green-400 transition-all hover:border-green-400/50 hover:bg-green-500/20 ${prefersReduced ? '' : 'gsap-fade'}`}
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
        className={`hero-cta inline-flex items-center gap-1 text-[14px] font-medium text-[#22d3ee] border-b border-[#22d3ee]/40 pb-px transition-colors hover:text-[#67e8f9] hover:border-[#67e8f9]/70 ${prefersReduced ? '' : 'gsap-fade'}`}
      >
        Earn as Creator <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}
