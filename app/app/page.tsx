"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import { isMockMode } from "@/lib/mock-mode";
import { MOCK_SLAB_ADDRESSES, getMockMarketData } from "@/lib/mock-trade-data";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { GradientText } from "@/components/ui/GradientText";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { OnboardingIcon } from "@/components/icons/OnboardingIcons";
import { HeroSection } from "@/components/marketing/HeroSection";

/** Format large numbers compactly: 1.2T / 3.4B / 5.6M / 7.8K */
function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000_000) return `$${(n / 1_000_000_000_000).toFixed(1)}T`;
  if (abs >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString()}`;
}

const HOW_STEPS = [
  {
    number: "01",
    title: "Paste a Token Address",
    desc: "Any Solana token. We auto-detect everything. No approval needed.",
    icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
    brandIcon: "perps" as const,
  },
  {
    number: "02",
    title: "Set Your Terms",
    desc: "Leverage, fees, initial liquidity. Smart defaults if you don't care.",
    icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
    brandIcon: "onchain" as const,
  },
  {
    number: "03",
    title: "Market Goes Live",
    desc: "Your market is deployed instantly on-chain. Share the link. Done.",
    icon: "M13 10V3L4 14h7v7l9-11h-7z",
    brandIcon: "deploy" as const,
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
                  <div className="flex h-12 w-12 items-center justify-center border border-[var(--accent)]/15 bg-[var(--accent)]/[0.04] transition-colors duration-200 group-hover:border-[var(--accent)]/30 group-hover:bg-[var(--accent)]/[0.08]">
                    <OnboardingIcon type={step.brandIcon} size={32} />
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
  // network config moved to HeroSection (PERC-158)

  useEffect(() => {
    async function loadStats() {
      // In mock mode, use synthetic data instead of Supabase
      if (isMockMode() || process.env.NODE_ENV === "development") {
        const mockFeatured = MOCK_SLAB_ADDRESSES.slice(0, 5).map((addr) => {
          const m = getMockMarketData(addr);
          if (!m) return null;
          const vol = Math.round(m.priceUsd * Number(m.oi) / 1_000_000 * 0.1);
          return {
            slab_address: addr,
            symbol: m.symbol,
            volume_24h: vol,
            last_price: m.priceUsd,
            total_open_interest: Math.round(Number(m.oi) / 1_000_000 * m.priceUsd),
          };
        }).filter(Boolean) as typeof featured;

        setStats({
          markets: MOCK_SLAB_ADDRESSES.length,
          volume: mockFeatured.reduce((s, m) => s + m.volume_24h, 0),
          insurance: 63200,
        });
        setStatsLoaded(true);
        setFeatured(mockFeatured);
        return;
      }

      try {
        const { data } = await getSupabase().from("markets_with_stats").select("slab_address, symbol, volume_24h, insurance_balance, last_price, total_open_interest, decimals") as { data: { slab_address: string; symbol: string | null; volume_24h: number | null; insurance_balance: number | null; last_price: number | null; total_open_interest: number | null; decimals: number | null }[] | null };
        if (data) {
          setStats({
            markets: data.length,
            // Convert raw token units to USD using per-market decimals and price
            volume: data.reduce((s, m) => {
              const d = 10 ** (m.decimals ?? 6);
              const price = m.last_price ?? 0;
              return s + (Number(m.volume_24h || 0) / d) * price;
            }, 0),
            // Convert insurance balance to USD using per-market decimals and price
            insurance: data.reduce((s, m) => {
              const d = 10 ** (m.decimals ?? 6);
              const price = m.last_price ?? 0;
              return s + (Number(m.insurance_balance || 0) / d) * price;
            }, 0),
          });
          setStatsLoaded(true);
          // Convert to USD first, then sort by converted volume
          const converted = data.map((m) => {
            const d = 10 ** (m.decimals ?? 6);
            const price = m.last_price ?? 0;
            return {
              slab_address: m.slab_address,
              symbol: m.symbol,
              volume_24h: (Number(m.volume_24h || 0) / d) * price,
              last_price: m.last_price,
              total_open_interest: (Number(m.total_open_interest || 0) / d) * price,
            };
          });
          const sorted = converted.sort((a, b) => b.volume_24h - a.volume_24h).slice(0, 5);
          setFeatured(sorted);
        }
      } catch (err) {
        console.error("Failed to load market stats:", err);
        setStatsLoaded(false);
      }
    }
    loadStats();
  }, []);

  // Health check moved to HeroSection component (PERC-158)

  const hasStats = stats.markets > 0;
  const hasMarkets = featured.length > 0 && featured.some((m) => m.volume_24h > 0);

  return (
    <div className="relative">
      {/* ═══════════════════════ HERO (PERC-158 refresh) ═══════════════════════ */}
      <ErrorBoundary label="Hero Section">
        <HeroSection />
      </ErrorBoundary>

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
                    { label: "Markets Live", value: statsLoaded ? String(stats.markets) : "—", color: "text-[var(--accent)]" },
                    { label: "24h Volume", value: statsLoaded ? formatCompact(stats.volume) : "—", color: "text-[var(--long)]" },
                    { label: "Insurance Fund", value: statsLoaded ? formatCompact(stats.insurance) : "—", color: "text-[var(--accent)]" },
                    { label: "Access", value: "Open", color: "text-[var(--long)]" },
                  ].map((stat) => (
                    <div key={stat.label} className="bg-[var(--panel-bg)] p-4 sm:p-5 transition-colors duration-200 hover:bg-[var(--bg-elevated)]">
                      <p className="mb-2 text-[9px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">{stat.label}</p>
                      <p className={`text-lg sm:text-xl font-semibold tracking-tight tabular-nums ${stat.color}`} style={{ fontFamily: "var(--font-heading)" }}>
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
                      {formatCompact(m.volume_24h)}
                    </div>
                    <div className="text-right text-[12px] text-[var(--text-secondary)]">
                      {formatCompact(m.total_open_interest)}
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
