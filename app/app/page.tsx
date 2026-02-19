"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import { getSupabase } from "@/lib/supabase";
import { getConfig } from "@/lib/config";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { GlassCard } from "@/components/ui/GlassCard";
import { GradientText } from "@/components/ui/GradientText";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

const HOW_STEPS = [
  {
    number: "01",
    title: "Paste a Token Address",
    desc: "Any Solana token. We auto-detect everything. No approval needed.",
    icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  },
  {
    number: "02",
    title: "Set Your Terms",
    desc: "Leverage, fees, initial liquidity. Smart defaults if you don't care.",
    icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  },
  {
    number: "03",
    title: "Market Goes Live",
    desc: "Your market is deployed instantly on-chain. Share the link. Done.",
    icon: "M13 10V3L4 14h7v7l9-11h-7z",
  },
];

function HowItWorks() {
  return (
    <section className="relative overflow-hidden py-16">
      <div className="mx-auto max-w-[1100px] px-6">
        <ScrollReveal>
          <div className="mb-10 text-center">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // how it works
            </div>
            <h2 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
              Three steps. <span className="font-normal text-[var(--text-muted)]">Sixty seconds.</span>
            </h2>
          </div>
        </ScrollReveal>

        <ScrollReveal>
          <div className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] md:grid-cols-3">
            {HOW_STEPS.map((step, i) => (
              <article
                key={step.number}
                className="group relative bg-[var(--panel-bg)] p-4 sm:p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)]"
              >
                <div className="mb-4 flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center border border-[var(--accent)]/15 bg-[var(--accent)]/[0.04] transition-colors duration-200 group-hover:border-[var(--accent)]/30 group-hover:bg-[var(--accent)]/[0.08]">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-[var(--accent)]">
                      <path d={step.icon} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <span className="text-[20px] font-normal tracking-tight text-[var(--border)] transition-colors duration-200 group-hover:text-[var(--accent)]/20" style={{ fontFamily: "var(--font-heading)" }}>
                    {step.number}
                  </span>
                </div>

                <h3 className="mb-2 text-[13px] sm:text-[14px] font-semibold tracking-tight text-white">
                  {step.title}
                </h3>
                <p className="text-[12px] sm:text-[12px] leading-relaxed text-[var(--text-secondary)]">{step.desc}</p>

                <div className="absolute bottom-0 left-0 right-0 h-px bg-[var(--accent)]/0 transition-all duration-300 group-hover:bg-[var(--accent)]/30" />
              </article>
            ))}
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

export default function Home() {
  const [stats, setStats] = useState({ markets: 0, volume: 0, insurance: 0 });
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [featured, setFeatured] = useState<{ slab_address: string; symbol: string | null; volume_24h: number; last_price: number | null; total_open_interest: number }[]>([]);
  const heroRef = useRef<HTMLDivElement>(null);
  const prefersReduced = usePrefersReducedMotion();
  const [scrollY, setScrollY] = useState(0);
  const [network, setNet] = useState(getConfig().network);
  const [sysStatus, setSysStatus] = useState<"online" | "degraded" | "offline" | "loading">("loading");

  // Hero stagger animation on mount
  useEffect(() => {
    if (prefersReduced || !heroRef.current) return;
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    const els = heroRef.current.querySelectorAll(".hero-stagger");
    tl.fromTo(
      els,
      { opacity: 0, y: 30, scale: 0.98 },
      { opacity: 1, y: 0, scale: 1, duration: 0.7, stagger: 0.1 }
    );
    return () => { tl.kill(); };
  }, [prefersReduced]);

  // Hero parallax on scroll (desktop only)
  useEffect(() => {
    if (prefersReduced) return;
    const isMobile = window.innerWidth < 768;
    if (isMobile) return;

    const onScroll = () => setScrollY(window.scrollY);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [prefersReduced]);

  useEffect(() => {
    async function loadStats() {
      try {
        const { data } = await getSupabase().from("markets_with_stats").select("slab_address, symbol, volume_24h, insurance_balance, last_price, total_open_interest") as { data: { slab_address: string; symbol: string | null; volume_24h: number | null; insurance_balance: number | null; last_price: number | null; total_open_interest: number | null }[] | null };
        if (data) {
          setStats({
            markets: data.length,
            volume: data.reduce((s, m) => s + Number(m.volume_24h || 0), 0),
            insurance: data.reduce((s, m) => s + Number(m.insurance_balance || 0), 0),
          });
          setStatsLoaded(true);
          const sorted = [...data].sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0)).slice(0, 5);
          setFeatured(sorted.map((m) => ({
            slab_address: m.slab_address,
            symbol: m.symbol,
            volume_24h: m.volume_24h || 0,
            last_price: m.last_price,
            total_open_interest: m.total_open_interest || 0,
          })));
        }
      } catch (err) {
        console.error("Failed to load market stats:", err);
        setStatsLoaded(false);
      }
    }
    loadStats();
  }, []);

  // Health check for sys.online badge (bug 62549a6c)
  useEffect(() => {
    async function checkHealth() {
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
    checkHealth();
    const interval = setInterval(checkHealth, 30_000);
    return () => clearInterval(interval);
  }, []);

  const hasStats = stats.markets > 0;
  const hasMarkets = featured.length > 0 && featured.some((m) => m.volume_24h > 0);

  return (
    <div className="relative">
      {/* ═══════════════════════ HERO ═══════════════════════ */}
      <section className="relative flex min-h-[85dvh] items-center justify-center">
        {/* Grid background — top-heavy with fade */}
        <div className="absolute inset-x-0 top-0 h-full bg-grid pointer-events-none" />

        {/* L1: HUD corner markers - decorative elements with aria-hidden */}
        <div className="pointer-events-none absolute inset-8 z-[2] hidden md:block" aria-hidden="true">
          <div className="absolute left-0 top-0 h-8 w-8 border-l border-t border-[var(--accent)]/15" />
          <div className="absolute right-0 top-0 h-8 w-8 border-r border-t border-[var(--accent)]/15" />
          <div className="absolute bottom-0 left-0 h-8 w-8 border-b border-l border-[var(--accent)]/15" />
          <div className="absolute bottom-0 right-0 h-8 w-8 border-b border-r border-[var(--accent)]/15" />
          {/* Coordinate labels */}
          <span className="absolute left-3 top-10 text-[8px] tracking-[0.2em] text-[var(--text-dim)]">0x00</span>
          <span className="absolute bottom-10 right-3 text-[8px] tracking-[0.2em] text-[var(--text-dim)]">0xFF</span>
        </div>

        {/* Content with parallax */}
        <div
          ref={heroRef}
          className="relative z-10 mx-auto max-w-[960px] px-6 text-center"
          style={!prefersReduced ? {
            transform: `translateY(${scrollY * 0.12}px)`,
            opacity: Math.max(0, 1 - scrollY / 700),
          } : undefined}
        >
          {/* System status — dynamic health check (bug 62549a6c) */}
          <div className="hero-stagger mb-5" style={{ opacity: prefersReduced ? 1 : 0 }}>
            <div className="inline-flex items-center gap-3 border border-[var(--border)] bg-[var(--bg)]/80 px-4 py-2 backdrop-blur-sm">
              <span className="relative flex h-1.5 w-1.5">
                {sysStatus === "online" && (
                  <>
                    <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${network === "mainnet" ? "bg-[var(--long)]" : "bg-[var(--accent)]"}`} />
                    <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${network === "mainnet" ? "bg-[var(--long)]" : "bg-[var(--accent)]"}`} />
                  </>
                )}
                {sysStatus === "degraded" && (
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
                )}
                {(sysStatus === "offline" || sysStatus === "loading") && (
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--short)]" />
                )}
              </span>
              <span className={`text-[9px] font-medium uppercase tracking-[0.2em] ${
                sysStatus === "online" ? "text-[var(--text-dim)]" :
                sysStatus === "degraded" ? "text-[var(--warning)]/70" :
                sysStatus === "offline" ? "text-[var(--short)]/70" :
                "text-[var(--text-dim)]"
              }`}>
                {sysStatus === "online" ? "sys.online" :
                 sysStatus === "degraded" ? "sys.degraded" :
                 sysStatus === "offline" ? "sys.offline" :
                 "sys.checking"}
              </span>
              <span className="h-2.5 w-px bg-[var(--border)]" />
              <span className="text-[9px] font-medium tracking-[0.15em] text-[var(--text-muted)]">
                SOLANA {network.toUpperCase()}
              </span>
            </div>
          </div>

          {/* Primary headline */}
          <h1
            className="hero-stagger mb-3 text-[clamp(2rem,7vw,5rem)] font-semibold leading-[0.95] tracking-[-0.03em] will-change-transform"
            style={{ fontFamily: "var(--font-display)", opacity: prefersReduced ? 1 : 0 }}
          >
            <span className="block text-white/70">Perpetuals</span>
            <span className="block">
              <GradientText variant="bright">Without Permission</GradientText>
            </span>
          </h1>

          {/* Accent rule */}
          <div className="hero-stagger mx-auto mb-4" style={{ opacity: prefersReduced ? 1 : 0 }}>
            <div className="hero-headline-rule" />
          </div>

          {/* Subtitle */}
          <p
            className="hero-stagger mx-auto mb-6 max-w-[480px] px-4 text-[14px] sm:text-[13px] leading-relaxed text-[var(--text-secondary)]"
            style={{ opacity: prefersReduced ? 1 : 0 }}
          >
            Deploy perpetual futures on any Solana token.{" "}
            <span className="text-[var(--text-muted)]">No governance. No contracts. Fully on-chain.</span>
          </p>

          {/* CTAs */}
          <div className="hero-stagger flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-3 w-full px-4 sm:w-auto sm:px-0" style={{ opacity: prefersReduced ? 1 : 0 }}>
            <Link
              href="/create"
              className="group relative inline-flex items-center justify-center gap-2 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.06] px-7 py-3.5 sm:py-3 text-[11px] font-bold uppercase tracking-[0.15em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.12] press min-h-[44px] w-full sm:w-auto"
              aria-label="Launch a new market"
            >
              <span className="relative z-10 flex items-center gap-2">
                Launch Market
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200 group-hover:translate-x-0.5">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </span>
            </Link>
            <Link
              href="/markets"
              className="relative inline-flex items-center justify-center border border-[var(--border)] bg-transparent px-7 py-3.5 sm:py-3 text-[11px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)] transition-all duration-200 hover:border-[var(--text-muted)] hover:text-[var(--text-secondary)] press min-h-[44px] w-full sm:w-auto"
              aria-label="Browse all markets"
            >
              Browse Markets
            </Link>
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 animate-fade-in delay-800">
          <div className="flex flex-col items-center gap-1 opacity-15">
            <div className="h-5 w-px bg-gradient-to-b from-[var(--text-dim)] to-transparent" />
          </div>
        </div>

      </section>

      {/* ═══════════════════════ STATS ═══════════════════════ */}
      {hasStats && (
        <ErrorBoundary label="Stats Section">
          <section className="relative py-16">
            <div className="mx-auto max-w-[1100px] px-6">
              <ScrollReveal>
                <div className="mb-10 text-center">
                  <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
                    // protocol metrics
                  </div>
                  <h2 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
                    Built <GradientText variant="muted">Different</GradientText>
                  </h2>
                </div>
              </ScrollReveal>

              <ScrollReveal stagger={0.08}>
                <div className="grid grid-cols-2 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] md:grid-cols-4">
                  {[
                    { label: "Markets Live", value: statsLoaded ? <AnimatedNumber value={stats.markets} decimals={0} /> : "—", color: "text-[var(--accent)]" },
                    { label: "24h Volume", value: statsLoaded ? <AnimatedNumber value={stats.volume / 1000} prefix="$" suffix="k" decimals={0} /> : "—", color: "text-[var(--long)]" },
                    { label: "Insurance Fund", value: statsLoaded ? <AnimatedNumber value={stats.insurance / 1000} prefix="$" suffix="k" decimals={0} /> : "—", color: "text-[var(--accent)]" },
                    { label: "Access", value: "Open", color: "text-[var(--long)]" },
                  ].map((stat) => (
                    <div key={stat.label} className="bg-[var(--panel-bg)] p-4 sm:p-6 transition-colors duration-200 hover:bg-[var(--bg-elevated)]">
                      <p className="mb-2 sm:mb-3 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">{stat.label}</p>
                      <p className={`text-xl sm:text-2xl md:text-3xl font-bold ${stat.color}`}>
                        {stat.value}
                      </p>
                    </div>
                  ))}
                </div>
              </ScrollReveal>
            </div>
          </section>
        </ErrorBoundary>
      )}

      {/* ═══════════════════════ HOW IT WORKS ═══════════════════════ */}
      <ErrorBoundary label="How It Works Section">
        <HowItWorks />
      </ErrorBoundary>

      {/* ═══════════════════════ FEATURES ═══════════════════════ */}
      <ErrorBoundary label="Features Section">
        <section className="relative overflow-hidden py-16">
          <div className="mx-auto max-w-[1100px] px-6">
            <ScrollReveal>
              <div className="mb-10 text-center">
                <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
                  // architecture
                </div>
                <h2 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
                  Purpose-Built <GradientText variant="muted">Infrastructure</GradientText>
                </h2>
              </div>
            </ScrollReveal>

          {/* Hero feature — full width with terminal mockup */}
          <ScrollReveal>
            <div className="mb-px overflow-hidden border border-[var(--border)] bg-[var(--panel-bg)]">
              <div className="grid grid-cols-1 md:grid-cols-2">
                <div className="p-4 sm:p-5">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex h-10 w-10 items-center justify-center border border-[var(--accent)]/15 bg-[var(--accent)]/[0.04]">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-[var(--accent)]">
                        <path d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A9 9 0 0 1 3 12c0-1.47.353-2.856.978-4.082" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
                      PERMISSIONLESS
                    </span>
                  </div>
                  <h3 className="mb-2 text-[15px] font-semibold tracking-tight text-white">No Permission Needed</h3>
                  <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
                    No governance, no whitelists, no waiting. Deploy your own perpetual market in 60 seconds.
                  </p>
                </div>
                {/* Terminal mockup */}
                <div className="flex items-center justify-center border-t border-[var(--border)] bg-[var(--bg)] p-6 md:border-l md:border-t-0">
                  <div className="w-full border border-[var(--border)] bg-[var(--bg-elevated)] p-4">
                    <div className="mb-3 flex items-center gap-1.5">
                      <div className="h-1.5 w-1.5 bg-[var(--short)]/50" />
                      <div className="h-1.5 w-1.5 bg-[var(--warning)]/50" />
                      <div className="h-1.5 w-1.5 bg-[var(--long)]/50" />
                    </div>
                    <div className="text-[12px] leading-relaxed">
                      <div className="text-[var(--text-muted)]">
                        <span className="text-[var(--accent)]">$</span> percolator create --token SOL
                      </div>
                      <div className="mt-1 text-[var(--text-dim)]">
                        initializing market...
                      </div>
                      <div className="mt-1 text-[var(--text-dim)]">
                        deploying slab... <span className="text-[var(--accent)]">done</span>
                      </div>
                      <div className="mt-1 text-[var(--long)]">
                        market live <span className="hero-terminal-cursor" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </ScrollReveal>

          {/* Feature cards — 3-column grid */}
          <ScrollReveal>
            <div className="grid grid-cols-1 gap-px overflow-hidden border border-t-0 border-[var(--border)] bg-[var(--border)] md:grid-cols-3">
              {[
                {
                  title: "Fully On-Chain",
                  desc: "Every trade, liquidation, and funding payment settled on Solana. Nothing custodial.",
                  icon: "M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z",
                  tag: "VERIFIED",
                },
                {
                  title: "Insurance Fund",
                  desc: "Every trade adds to it. Your market stays solvent even when someone gets rekt.",
                  icon: "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z",
                  tag: "ACTIVE",
                },
                {
                  title: "Burn the Admin Key",
                  desc: "One click and it\u2019s immutable forever. Your market, your rules, permanently.",
                  icon: "M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25z",
                  tag: "NOVEL",
                },
              ].map((f) => (
                <article key={f.title} className="group relative h-full bg-[var(--panel-bg)] p-4 sm:p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)]">
                  <div className="mb-4 flex items-center justify-between">
                    <div className="flex h-10 w-10 items-center justify-center border border-[var(--accent)]/15 bg-[var(--accent)]/[0.04] transition-colors duration-200 group-hover:border-[var(--accent)]/30">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-[var(--accent)]">
                        <path d={f.icon} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <span className="text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)] transition-colors duration-200 group-hover:text-[var(--accent)]/40">
                      {f.tag}
                    </span>
                  </div>
                  <h3 className="mb-2 text-[13px] sm:text-[14px] font-semibold tracking-tight text-white">{f.title}</h3>
                  <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">{f.desc}</p>
                  <div className="absolute bottom-0 left-0 right-0 h-px bg-[var(--accent)]/0 transition-all duration-300 group-hover:bg-[var(--accent)]/30" />
                </article>
              ))}
            </div>
          </ScrollReveal>
        </div>
      </section>
      </ErrorBoundary>

      {/* ═══════════════════════ FEATURED MARKETS ═══════════════════════ */}
      {hasMarkets && (
        <ErrorBoundary label="Featured Markets Section">
        <section className="relative py-16">
          <div className="mx-auto max-w-[1100px] px-6">
            <ScrollReveal>
              <div className="mb-10 text-center">
                <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
                  // live data
                </div>
                <h2 className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl" style={{ fontFamily: "var(--font-heading)" }}>
                  Active Markets
                </h2>
              </div>

              <div className="overflow-x-auto border border-[var(--border)] bg-[var(--panel-bg)]">
                <div className="grid min-w-[480px] grid-cols-5 gap-2 sm:gap-4 border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 sm:px-5 py-3 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
                  <div>Token</div>
                  <div className="text-right">Price</div>
                  <div className="text-right">Volume</div>
                  <div className="text-right">OI</div>
                  <div className="text-right">Status</div>
                </div>
                {featured.map((m) => (
                  <Link
                    key={m.slab_address}
                    href={`/trade/${m.slab_address}`}
                    className="group relative grid min-w-[480px] grid-cols-5 gap-2 sm:gap-4 border-b border-[var(--border-subtle)] px-3 sm:px-5 py-3.5 text-sm transition-all duration-150 last:border-b-0 hover:bg-[var(--accent)]/[0.03] min-h-[48px]"
                    aria-label={`Trade ${m.symbol ? `${m.symbol}/USD` : `market ${m.slab_address.slice(0, 6)}`}`}
                  >
                    <div className="absolute left-0 top-0 bottom-0 w-px bg-[var(--accent)] opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
                    <div className="text-[13px] font-semibold text-white">
                      {m.symbol ? `${m.symbol}/USD` : `${m.slab_address.slice(0, 6)}...`}
                    </div>
                    <div className="text-right text-[12px] text-[var(--text-secondary)]">
                      {m.last_price != null
                        ? `$${m.last_price < 0.01 ? m.last_price.toFixed(6) : m.last_price < 1 ? m.last_price.toFixed(4) : m.last_price.toFixed(2)}`
                        : "\u2014"}
                    </div>
                    <div className="text-right text-[12px] text-[var(--text-secondary)]">
                      {m.volume_24h >= 1000 ? `$${(m.volume_24h / 1000).toFixed(1)}k` : `$${m.volume_24h}`}
                    </div>
                    <div className="text-right text-[12px] text-[var(--text-secondary)]">
                      {m.total_open_interest >= 1000 ? `$${(m.total_open_interest / 1000).toFixed(1)}k` : `$${m.total_open_interest}`}
                    </div>
                    <div className="text-right text-[11px] text-[var(--long)]">LIVE</div>
                  </Link>
                ))}
              </div>

              <div className="mt-5 text-center">
                <Link
                  href="/markets"
                  className="inline-flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)]"
                >
                  View All Markets
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </Link>
              </div>
            </ScrollReveal>
          </div>
        </section>
        </ErrorBoundary>
      )}

      {/* ═══════════════════════ BOTTOM CTA ═══════════════════════ */}
      <section className="relative overflow-hidden pt-16 pb-28">
        <ScrollReveal>
          <div className="relative z-10 mx-auto max-w-[1100px] px-6 text-center">
            <div className="mb-3 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // deploy
            </div>
            <h2
              className="mb-5 text-3xl font-medium tracking-[-0.02em] sm:text-4xl lg:text-5xl"
              style={{ fontFamily: "var(--font-heading)" }}
            >
              <span className="font-normal text-white/60">Ready to </span><GradientText variant="bright">Percolate?</GradientText>
            </h2>
            <p className="mx-auto mb-8 max-w-md text-[14px] text-[var(--text-secondary)]">
              Deploy a perpetual futures market in 60 seconds. No permission needed.
            </p>
            <Link
              href="/create"
              className="group inline-flex items-center justify-center gap-2.5 border border-[var(--accent)]/50 bg-[var(--accent)]/[0.06] px-8 sm:px-10 py-4 text-[12px] sm:text-[13px] font-bold uppercase tracking-[0.15em] text-[var(--accent)] transition-all duration-200 hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.12] press min-h-[48px]"
              aria-label="Launch a new perpetual market"
            >
              <span className="relative z-10 flex items-center gap-2.5">
                Launch Market
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200 group-hover:translate-x-0.5">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </span>
            </Link>
          </div>
        </ScrollReveal>
      </section>
    </div>
  );
}
