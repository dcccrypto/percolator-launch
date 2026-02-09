"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { getSupabase } from "@/lib/supabase";
import { getConfig } from "@/lib/config";
import { GlassCard } from "@/components/ui/GlassCard";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { GradientText } from "@/components/ui/GradientText";
import { GlowButton } from "@/components/ui/GlowButton";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger);
}

const CA = "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump";

/* ─── Icons ─── */
function IconLock({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function IconFlame({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
}

function IconChart({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function IconZap({ className }: { className?: string }) {
  return (
    <svg className={className} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

/* ─── Floating Orbs ─── */
function BackgroundOrbs() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const orbs = containerRef.current.querySelectorAll(".orb");
    orbs.forEach((orb, i) => {
      gsap.to(orb, {
        y: `random(-60, 60)`,
        x: `random(-40, 40)`,
        scale: `random(0.8, 1.2)`,
        duration: `random(6, 10)`,
        ease: "sine.inOut",
        repeat: -1,
        yoyo: true,
        delay: i * 0.8,
      });
    });
  }, []);

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="orb absolute left-1/2 top-0 -translate-x-1/2 h-[700px] w-[900px] rounded-full bg-[#00FFB2]/[0.03] blur-[180px]" />
      <div className="orb absolute -left-40 top-1/3 h-[500px] w-[500px] rounded-full bg-[#7B61FF]/[0.04] blur-[150px]" />
      <div className="orb absolute right-0 top-2/3 h-[400px] w-[400px] rounded-full bg-[#00FFB2]/[0.02] blur-[120px]" />
    </div>
  );
}

/* ─── Hero Text Reveal ─── */
function HeroTitle() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      containerRef.current.querySelectorAll(".hero-word").forEach((el) => {
        (el as HTMLElement).style.opacity = "1";
        (el as HTMLElement).style.transform = "none";
      });
      return;
    }

    const words = containerRef.current.querySelectorAll(".hero-word");
    gsap.fromTo(
      words,
      { opacity: 0, y: 40, rotateX: -20 },
      { opacity: 1, y: 0, rotateX: 0, duration: 0.8, stagger: 0.12, ease: "power3.out", delay: 0.2 }
    );
  }, []);

  return (
    <div ref={containerRef} className="perspective-[1000px]">
      <h1 className="mb-6 text-5xl font-bold tracking-tight md:text-7xl lg:text-8xl" style={{ fontFamily: "var(--font-space-grotesk)" }}>
        <span className="hero-word inline-block opacity-0">
          <GradientText className="font-bold">Percolator</GradientText>
        </span>
      </h1>
      <p className="hero-word mx-auto mb-3 max-w-2xl text-lg font-medium text-[#c4cbde] opacity-0 md:text-xl">
        Launch leveraged trading markets for any Solana token.
        <br className="hidden sm:block" />
        No code. No permission. One click.
      </p>
      <p className="hero-word mx-auto mb-8 max-w-xl text-sm text-[#5a6382] opacity-0">
        Pick any Solana token, set your leverage and fees, deploy on-chain.
        Anyone can bet on price going up or down — immediately. Powered by Percolator.
      </p>
    </div>
  );
}

export default function Home() {
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState({ markets: 0, volume: 0, insurance: 0 });
  const [featured, setFeatured] = useState<{ slab_address: string; symbol: string | null; volume_24h: number }[]>([]);
  const [cfg, setCfg] = useState<{ programId: string; network: string }>({ programId: "", network: "devnet" });
  const ctaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const c = getConfig();
    setCfg({ programId: c.programId ?? "", network: c.network ?? "devnet" });
  }, []);

  useEffect(() => {
    if (!ctaRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(
      ctaRef.current.children,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.6, stagger: 0.1, ease: "power3.out", delay: 0.8 }
    );
  }, []);

  const copyCA = () => {
    navigator.clipboard.writeText(CA);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    async function loadStats() {
      const { data } = await getSupabase().from("markets_with_stats").select("slab_address, symbol, volume_24h, insurance_balance") as { data: { slab_address: string; symbol: string | null; volume_24h: number | null; insurance_balance: number | null }[] | null };
      if (data) {
        setStats({
          markets: data.length,
          volume: data.reduce((s, m) => s + (m.volume_24h || 0), 0),
          insurance: data.reduce((s, m) => s + (m.insurance_balance || 0), 0),
        });
        const sorted = [...data].sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0)).slice(0, 4);
        setFeatured(sorted.map((m) => ({ slab_address: m.slab_address, symbol: m.symbol, volume_24h: m.volume_24h || 0 })));
      }
    }
    loadStats();
  }, []);

  const hasRealStats = stats.markets > 0;
  const hasRealMarkets = featured.length > 0 && featured.some((m) => m.volume_24h > 0);
  const isDevnet = cfg.network === "devnet";

  return (
    <div className="relative overflow-hidden">
      <BackgroundOrbs />

      {/* Hero */}
      <div className="relative mx-auto max-w-5xl px-4 pb-16 pt-24 md:pt-32">
        <div className="text-center">
          {/* Network badge */}
          {isDevnet && (
            <ScrollReveal delay={0}>
              <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-[#FFB800]/10 bg-[#FFB800]/[0.05] px-4 py-1.5 text-[12px] font-medium text-[#FFB800]">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FFB800] opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#FFB800]" />
                </span>
                Devnet
              </div>
            </ScrollReveal>
          )}

          <HeroTitle />

          {/* CTAs */}
          <div ref={ctaRef} className="mb-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/create">
              <GlowButton size="lg">Launch a Market</GlowButton>
            </Link>
            <Link href="/markets">
              <GlowButton variant="secondary" size="lg">Browse Markets</GlowButton>
            </Link>
          </div>
        </div>
      </div>

      {/* Stats — only show if there's real data */}
      {hasRealStats && (
        <ScrollReveal>
          <div className="relative mx-auto max-w-5xl px-4 pb-20">
            <div className="grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-xl">
              {[
                { label: "Markets Live", value: stats.markets, prefix: "", suffix: "", decimals: 0 },
                { label: "24h Volume", value: stats.volume / 1000, prefix: "$", suffix: "K", decimals: 0 },
                { label: "Insurance Pool", value: stats.insurance / 1000, prefix: "$", suffix: "K", decimals: 0 },
              ].map((s) => (
                <div key={s.label} className="p-6 text-center md:p-8">
                  <div className="text-2xl font-bold text-white md:text-3xl" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                    {s.value ? (
                      <AnimatedNumber value={s.value} prefix={s.prefix} suffix={s.suffix} decimals={s.decimals} />
                    ) : (
                      "—"
                    )}
                  </div>
                  <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.2em] text-[#3D4563]">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </ScrollReveal>
      )}

      {/* How it works */}
      <div className="relative mx-auto max-w-5xl px-4 pb-24">
        <ScrollReveal>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.25em] text-[#00FFB2]/60">How it works</div>
          <h2 className="mb-4 text-3xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
            Three steps to a live market
          </h2>
          <p className="mb-10 max-w-xl text-sm text-[#5a6382]">
            No contracts to write. No team to convince. You go from idea to tradeable perp in under a minute.
          </p>
        </ScrollReveal>

        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              num: "01",
              title: "Choose a token",
              desc: "Paste any Solana token mint address. Percolator pulls the metadata, logo, and live price automatically via Jupiter.",
            },
            {
              num: "02",
              title: "Configure your market",
              desc: "Set max leverage (2-20x), trading fees, and initial insurance deposit. You control the economics. Defaults work fine too.",
            },
            {
              num: "03",
              title: "Deploy on-chain",
              desc: "One transaction. Market is live immediately. Share the link — anyone with a Solana wallet can open long or short positions.",
            },
          ].map((item, i) => (
            <ScrollReveal key={item.num} delay={i * 0.15}>
              <GlassCard glow className="h-full">
                <div className="mb-6">
                  <span className="font-[var(--font-jetbrains-mono)] text-xs font-bold text-[#00FFB2]/40">{item.num}</span>
                </div>
                <h3 className="mb-3 text-lg font-bold text-white">{item.title}</h3>
                <p className="text-sm leading-relaxed text-[#8B95B0]">{item.desc}</p>
              </GlassCard>
            </ScrollReveal>
          ))}
        </div>
      </div>

      {/* Features */}
      <div className="relative mx-auto max-w-5xl px-4 pb-24">
        <ScrollReveal>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.25em] text-[#7B61FF]/60">Why Percolator</div>
          <h2 className="mb-4 text-3xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
            What makes this different
          </h2>
          <p className="mb-10 max-w-xl text-sm text-[#5a6382]">
            Most perp DEXs pick which tokens to list. Here, you do.
          </p>
        </ScrollReveal>

        <div className="grid gap-4 md:grid-cols-2">
          {[
            {
              icon: <IconLock className="text-[#00FFB2]" />,
              title: "Anyone can deploy a market",
              desc: "No whitelisting, no governance votes, no waiting. Paste a token mint, click deploy. The protocol doesn't gate what gets listed — you decide.",
              accent: "#00FFB2",
            },
            {
              icon: <IconFlame className="text-[#FF4466]" />,
              title: "Fees fund the insurance pool",
              desc: "Every trade sends a cut to the market's insurance fund. This backs liquidations and keeps the market solvent. Admin keys can be burned to lock fees permanently.",
              accent: "#FF4466",
            },
            {
              icon: <IconChart className="text-[#7B61FF]" />,
              title: "Up to 20x leverage, long or short",
              desc: "Real on-chain perpetual futures with configurable leverage. Positions are settled against the insurance pool. No synthetic wrapping or off-chain matching.",
              accent: "#7B61FF",
            },
            {
              icon: <IconZap className="text-[#FFB800]" />,
              title: "Solana-native performance",
              desc: "Trades settle in under a second. Costs a fraction of a cent. Prices sourced from Jupiter and DexScreener oracles. Automated keepers handle liquidations.",
              accent: "#FFB800",
            },
          ].map((f, i) => (
            <ScrollReveal key={f.title} delay={i * 0.1}>
              <GlassCard hover glow={false} className="group h-full">
                <div
                  className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-white/[0.04] transition-all duration-300 group-hover:scale-110 group-hover:bg-white/[0.08]"
                  style={{ boxShadow: `0 0 20px ${f.accent}10` }}
                >
                  {f.icon}
                </div>
                <h3 className="mb-2 text-base font-bold text-white">{f.title}</h3>
                <p className="text-sm leading-relaxed text-[#8B95B0]">{f.desc}</p>
              </GlassCard>
            </ScrollReveal>
          ))}
        </div>
      </div>

      {/* Featured markets — only show if there are real markets with volume */}
      {hasRealMarkets ? (
        <div className="relative mx-auto max-w-5xl px-4 pb-24">
          <ScrollReveal>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.25em] text-[#00FFB2]/60">Markets</div>
            <h2 className="mb-8 text-3xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
              Active markets
            </h2>
          </ScrollReveal>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {featured.map((m, i) => (
              <ScrollReveal key={m.slab_address} delay={i * 0.1}>
                <Link href={`/trade/${m.slab_address}`}>
                  <GlassCard hover glow className="group cursor-pointer">
                    <div className="mb-2 text-base font-bold text-white transition-colors group-hover:text-[#00FFB2]">
                      {m.symbol ? `${m.symbol}/USD` : `${m.slab_address.slice(0, 6)}...`}
                    </div>
                    <div className="font-[var(--font-jetbrains-mono)] text-xs text-[#3D4563]">
                      Vol: <span className="text-[#8B95B0]">{m.volume_24h >= 1000 ? `$${(m.volume_24h / 1000).toFixed(1)}K` : `$${m.volume_24h.toLocaleString()}`}</span>
                    </div>
                    <div className="mt-3 text-[11px] font-medium text-[#00FFB2] opacity-0 transition-all duration-300 group-hover:opacity-100">
                      Trade →
                    </div>
                  </GlassCard>
                </Link>
              </ScrollReveal>
            ))}
          </div>
        </div>
      ) : (
        <div className="relative mx-auto max-w-5xl px-4 pb-24">
          <ScrollReveal>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.25em] text-[#00FFB2]/60">Markets</div>
            <h2 className="mb-4 text-3xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
              Be the first to launch
            </h2>
            <p className="mb-8 text-sm text-[#5a6382]">
              No markets deployed yet. Create the first perpetual futures market on Percolator.
            </p>
            <Link href="/create">
              <GlowButton variant="secondary">Create a Market</GlowButton>
            </Link>
          </ScrollReveal>
        </div>
      )}

      {/* Bottom CTA */}
      <ScrollReveal>
        <div className="relative mx-auto max-w-5xl px-4 pb-24">
          <div className="gradient-border rounded-2xl border border-white/[0.06] bg-white/[0.02] p-12 text-center backdrop-blur-xl md:p-16">
            <h2 className="mb-4 text-4xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
              Ready to launch?
            </h2>
            <p className="mb-8 text-[#8B95B0]">Deploy a perpetual futures market in under 60 seconds.</p>
            <Link href="/create">
              <GlowButton size="lg">Launch a Market</GlowButton>
            </Link>
          </div>
        </div>
      </ScrollReveal>

      {/* Footer */}
      <div className="relative mx-auto max-w-5xl px-4 pb-8">
        <div className="flex flex-col items-center gap-4 border-t border-white/[0.04] pt-8">
          {/* CA — subtle, not the main focus */}
          <button
            onClick={copyCA}
            className="group flex items-center gap-2 text-[11px] text-[#3D4563] transition-colors hover:text-[#5a6382]"
          >
            <span className="font-bold tracking-wider text-[#00FFB2]/40">CA</span>
            <code className="font-[var(--font-jetbrains-mono)]">
              {CA.slice(0, 8)}...{CA.slice(-6)}
            </code>
            <span className="text-[#00FFB2]/40 transition-colors group-hover:text-[#00FFB2]">
              {copied ? "copied" : "copy"}
            </span>
          </button>

          {/* Links */}
          <div className="flex flex-wrap items-center justify-center gap-6 text-[11px] text-[#3D4563]">
            <a href={`https://explorer.solana.com/address/${cfg.programId}?cluster=${cfg.network}`} target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[#8B95B0]">
              Program: <span className="font-[var(--font-jetbrains-mono)]">{cfg.programId ? `${cfg.programId.slice(0, 6)}...${cfg.programId.slice(-4)}` : "..."}</span>
            </a>
            <a href="https://github.com/dcccrypto/percolator-launch" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[#8B95B0]">
              GitHub
            </a>
            <a href="https://x.com/aaboroday" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[#8B95B0]">
              Built on toly&apos;s Percolator
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
