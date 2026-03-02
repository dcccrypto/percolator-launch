"use client";

import Link from "next/link";
import { MiniSparkline } from "./MiniSparkline";
import { MiniOrderBook } from "./MiniOrderBook";

export function LiveMarketCard({ className = "", animate = true }: { className?: string; animate?: boolean }) {
  return (
    <div className={`relative ${className}`}>
      {/* Ambient glow behind card */}
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(ellipse 400px 600px at 50% 50%, rgba(124,58,237,0.12), transparent)",
        }}
      />

      {/* Floating card */}
      <div
        className="w-full max-w-[380px] overflow-hidden border border-[var(--border)] bg-[var(--panel-bg)]"
        style={{
          animation: "market-card-float 4s ease-in-out infinite",
          willChange: "transform",
          boxShadow: "0 0 40px rgba(153,69,255,0.08), 0 0 80px rgba(20,241,149,0.04)",
        }}
      >
        {/* Card header */}
        <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div
              className="flex h-8 w-8 items-center justify-center border border-[var(--accent)]/20 bg-[var(--accent)]/[0.10] text-xs font-bold text-[var(--accent)]"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              S
            </div>
            <div>
              <div className="text-sm font-semibold text-[var(--text)]" style={{ fontFamily: "var(--font-heading)" }}>SOL-PERP</div>
              <div className="text-[10px] text-[var(--text-muted)]">
                Perpetual · 20x max
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="inline-flex items-center gap-1 border border-[var(--long)]/30 bg-[var(--long)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--long)]">
              <span className="h-1.5 w-1.5 bg-[var(--long)] animate-pulse" />
              LIVE
            </div>
            <div className="mt-0.5 text-[11px] font-medium text-[var(--long)]" style={{ fontFamily: "var(--font-heading)" }}>
              +3.24% ↑
            </div>
          </div>
        </div>

        {/* Mini price chart */}
        <div className="px-5 pt-4">
          <MiniSparkline width={340} height={120} basePrice={185.4} />
        </div>

        {/* Mini order book */}
        <div className="px-5 py-3 hidden md:block">
          <MiniOrderBook />
        </div>

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-2 px-5 pb-3">
          <Link
            href="/markets"
            className="flex h-10 items-center justify-center border border-[var(--long)]/40 bg-[var(--long)]/[0.12] text-sm font-bold text-[var(--long)] transition-colors hover:bg-[var(--long)]/[0.20]"
          >
            LONG
          </Link>
          <Link
            href="/markets"
            className="flex h-10 items-center justify-center border border-[var(--short)]/40 bg-[var(--short)]/[0.12] text-sm font-bold text-[var(--short)] transition-colors hover:bg-[var(--short)]/[0.20]"
          >
            SHORT
          </Link>
        </div>

        {/* Card footer */}
        <div className="border-t border-[var(--border-subtle)] px-5 py-2.5 text-center text-[11px] text-[var(--text-muted)]">
          8% Creator Fee · $2,500 seed · Launch in 60s
        </div>
      </div>
    </div>
  );
}
