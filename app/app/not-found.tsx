"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import gsap from "gsap";

export default function NotFound() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      containerRef.current.style.opacity = "1";
      return;
    }
    gsap.fromTo(
      containerRef.current,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.6, ease: "power3.out" }
    );
  }, []);

  return (
    <div className="min-h-[calc(100vh-48px)] relative flex items-center justify-center">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
      <div ref={containerRef} className="relative mx-auto max-w-xl px-4 py-20 text-center" style={{ opacity: 0 }}>
        <div className="mb-4">
          <span className="text-[80px] font-bold text-[var(--accent)] leading-none" style={{ fontFamily: "var(--font-heading)" }}>
            404
          </span>
        </div>
        
        <h1 className="mb-3 text-2xl font-semibold text-white" style={{ fontFamily: "var(--font-heading)" }}>
          Market Not Found
        </h1>
        
        <p className="mb-8 text-[13px] leading-relaxed text-[var(--text-secondary)]">
          The page you&apos;re looking for doesn&apos;t exist. It might have been removed, renamed, or never existed in the first place.
        </p>

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-6 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--accent)] transition-all hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15]"
          >
            Go Home
          </Link>
          <Link
            href="/markets"
            className="border border-[var(--border)] px-6 py-3 text-xs font-medium uppercase tracking-wider text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/30 hover:text-white"
          >
            Browse Markets
          </Link>
        </div>

        {/* Decorative corner elements */}
        <div className="absolute left-0 top-0 h-2 w-2 border-l border-t border-[var(--accent)]/20" aria-hidden="true" />
        <div className="absolute right-0 top-0 h-2 w-2 border-r border-t border-[var(--accent)]/20" aria-hidden="true" />
        <div className="absolute bottom-0 left-0 h-2 w-2 border-b border-l border-[var(--accent)]/20" aria-hidden="true" />
        <div className="absolute bottom-0 right-0 h-2 w-2 border-b border-r border-[var(--accent)]/20" aria-hidden="true" />
      </div>
    </div>
  );
}
