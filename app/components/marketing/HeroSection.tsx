"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { getConfig } from "@/lib/config";
import { isMockMode } from "@/lib/mock-mode";
import { MOCK_SLAB_ADDRESSES } from "@/lib/mock-trade-data";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { HeroHeadline } from "./HeroHeadline";
import { HeroStats } from "./HeroStats";
import { HeroCtaGroup } from "./HeroCtaGroup";
import { LiveMarketCard } from "./LiveMarketCard";
import { HeroDataChip } from "./HeroDataChip";

export function HeroSection() {
  const containerRef = useRef<HTMLElement>(null);
  const prefersReduced = usePrefersReducedMotion();
  const [network] = useState(getConfig().network);
  const [sysStatus, setSysStatus] = useState<
    "online" | "degraded" | "offline" | "loading"
  >("loading");
  const [stats, setStats] = useState({ markets: 0, volume: 0, traders: 0 });

  // Health check
  useEffect(() => {
    async function check() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          setSysStatus(data.status as "online" | "degraded" | "offline");
        } else {
          setSysStatus("offline");
        }
      } catch {
        setSysStatus("offline");
      }
    }
    check();
    const interval = setInterval(check, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Load stats
  useEffect(() => {
    if (isMockMode() || process.env.NODE_ENV === "development") {
      setStats({
        markets: MOCK_SLAB_ADDRESSES.length,
        volume: 124_000,
        traders: 847,
      });
    }
    // TODO: pull from live API when available
  }, []);

  // Eyebrow + sub fade in
  useEffect(() => {
    if (prefersReduced || !containerRef.current) return;
    const els = containerRef.current.querySelectorAll(".hero-fade");
    gsap.fromTo(
      els,
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.4, stagger: 0.1, ease: "power2.out" }
    );
  }, [prefersReduced]);

  const statusDotClass =
    sysStatus === "online"
      ? network === "mainnet"
        ? "bg-[var(--long)]"
        : "bg-[var(--accent)]"
      : sysStatus === "degraded"
        ? "bg-[var(--warning)]"
        : "bg-[var(--short)]";

  const statusLabel =
    sysStatus === "online"
      ? "sys.online"
      : sysStatus === "degraded"
        ? "sys.degraded"
        : sysStatus === "offline"
          ? "sys.offline"
          : "sys.checking";

  return (
    <section
      ref={containerRef}
      className="relative flex min-h-[80vh] items-center overflow-hidden"
    >
      {/* ── Background layers ── */}
      <div className="absolute inset-x-0 top-0 h-full bg-grid pointer-events-none" />
      {/* Purple left glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 700px 500px at -100px 300px, rgba(124,58,237,0.08), transparent)",
        }}
      />
      {/* Cyan right glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 500px 600px at calc(100% + 100px) 200px, rgba(34,211,238,0.06), transparent)",
        }}
      />
      {/* Center horizon */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, transparent, rgba(124,58,237,0.03) 30%, rgba(34,211,238,0.03) 70%, transparent)",
        }}
      />

      {/* ── Content ── */}
      <div className="relative z-10 mx-auto grid w-full max-w-[1280px] grid-cols-1 items-center gap-12 px-6 pt-12 pb-16 md:grid-cols-[55%_45%] lg:gap-16">
        {/* LEFT COLUMN */}
        <div className="flex flex-col gap-6">
          {/* Eyebrow badge */}
          <div
            className={`hero-fade ${prefersReduced ? '' : 'gsap-fade'}`}
          >
            <div className="inline-flex items-center gap-2 rounded-full border border-purple-500/40 bg-purple-500/10 px-3 py-1">
              <span className="relative flex h-2 w-2">
                {sysStatus === "online" && (
                  <span
                    className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${statusDotClass}`}
                  />
                )}
                <span
                  className={`relative inline-flex h-2 w-2 rounded-full ${statusDotClass}`}
                />
              </span>
              <span
                className="text-[12px] font-medium uppercase tracking-widest text-purple-300"
                style={{ fontFamily: "var(--font-heading)" }}
              >
                Live on Solana {network === "mainnet" ? "Mainnet" : "Devnet"}
              </span>
            </div>
          </div>

          {/* Headline */}
          <HeroHeadline />

          {/* Subheadline */}
          <p
            className={`hero-fade max-w-[520px] text-base leading-[1.6] text-[#d1d5db] sm:text-lg ${prefersReduced ? '' : 'gsap-fade'}`}
          >
            Deploy a perpetual futures market for any Solana token.
            <br />
            No permission. No admin key. No gatekeepers.
            <br />
            <span className="text-[#9ca3af]">
              Earn 8% of all trading fees as the market creator.
            </span>
          </p>

          {/* Stats row */}
          <HeroStats
            markets={stats.markets}
            volume={stats.volume}
            traders={stats.traders}
            isDevnet={network !== "mainnet"}
          />

          {/* CTAs */}
          <HeroCtaGroup />

          {/* Social proof bar */}
          <div
            className={`hero-fade flex flex-wrap items-center gap-4 text-[12px] text-[#6b7280] ${prefersReduced ? '' : 'gsap-fade'}`}
          >
            <span className="flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-[#6b7280]">
                <circle cx="12" cy="12" r="10" />
              </svg>
              Powered by Solana
            </span>
            <span className="flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[#6b7280]">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              Open Source
            </span>
            <span className="flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-[#6b7280]">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              MIT License
            </span>
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="relative flex items-center justify-center">
          {/* Floating data chips */}
          <HeroDataChip
            icon="📈"
            text="$47K vol/hr"
            delay={1.0}
            floatPhase={2}
            className="absolute -left-4 -top-4 z-20 lg:left-0 lg:-top-8"
          />
          <HeroDataChip
            icon="⚡"
            text="412ms fill time"
            delay={1.2}
            floatPhase={0}
            className="absolute -bottom-4 -right-4 z-20 lg:right-0 lg:-bottom-8"
          />

          <LiveMarketCard className="w-full flex justify-center" />
        </div>
      </div>
    </section>
  );
}
