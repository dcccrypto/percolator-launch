"use client";

import Link from "next/link";

export default function Home() {
  return (
    <div className="relative flex min-h-[calc(100dvh-3.5rem)] flex-col items-center justify-center px-6 py-20">
      <div className="mx-auto max-w-[600px] text-center">
        {/* Label */}
        <div className="mb-4 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
          // v17 devnet
        </div>

        {/* Title */}
        <h1
          className="mb-4 text-4xl font-bold tracking-tight text-[var(--text)]"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Percolator Playground
        </h1>

        {/* Subtitle */}
        <p className="mb-10 text-[15px] leading-relaxed text-[var(--text-secondary)]">
          Trade permissionless perps. Launch markets for any mainnet token.
        </p>

        {/* CTAs */}
        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/markets"
            className="group inline-flex items-center justify-center gap-2 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.06] px-8 py-3.5 text-[12px] font-bold uppercase tracking-[0.12em] text-[var(--accent)] transition-all duration-200 hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.12] min-h-[48px]"
          >
            Browse Markets
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-150 group-hover:translate-x-0.5">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </Link>
          <Link
            href="/create"
            className="inline-flex items-center justify-center gap-2 border border-[var(--border)] bg-[var(--panel-bg)] px-8 py-3.5 text-[12px] font-bold uppercase tracking-[0.12em] text-[var(--text-secondary)] transition-all duration-200 hover:border-[var(--border-hover)] hover:text-[var(--text)] min-h-[48px]"
          >
            Launch Market
          </Link>
        </div>

        {/* Network badge */}
        <div className="mt-12 inline-flex items-center gap-2 border border-[#fbbf24]/20 bg-[#fbbf24]/[0.06] px-4 py-2 text-[11px] text-[#fbbf24]/80">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#fbbf24]/60" />
          Connected to devnet - no real funds at risk
        </div>
      </div>
    </div>
  );
}
