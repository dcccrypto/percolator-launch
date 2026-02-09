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
      <p className="hero-word mx-auto mb-3 max-w-lg text-lg font-medium text-[#8B95B0] opacity-0 md:text-xl">
        Permissionless perpetual futures on Solana
      </p>
      <p className="hero-word mx-auto mb-8 max-w-xl text-sm text-[#3D4563] opacity-0">
        Deploy a leveraged perp market for any SPL token in one click.
        Up to 20× leverage. No governance. No permission.
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

  // Animate CTAs on mount
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

  return (
    <div className="relative overflow-hidden">
      <BackgroundOrbs />

      {/* Hero */}
      <div className="relative mx-auto max-w-5xl px-4 pb-16 pt-24 md:pt-32">
        <div className="text-center">
          {/* Live badge */}
          <ScrollReveal delay={0}>
            <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-[#00FFB2]/10 bg-[#00FFB2]/[0.05] px-4 py-1.5 text-[12px] font-medium text-[#00FFB2]">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#00FFB2] opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#00FFB2]" />
              </span>
              Live on Solana
            </div>
          </ScrollReveal>

          <HeroTitle />

          {/* CTAs */}
          <div ref={ctaRef} className="mb-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/create">
              <GlowButton size="lg">Launch a Market →</GlowButton>
            </Link>
            <Link href="/markets">
              <GlowButton variant="secondary" size="lg">Browse Markets</GlowButton>
            </Link>
          </div>

          {/* CA */}
          <button
            onClick={copyCA}
            className="group mx-auto flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 backdrop-blur-sm transition-all hover:border-[#00FFB2]/20 hover:bg-white/[0.04]"
          >
            <span className="text-[10px] font-bold tracking-widest text-[#00FFB2]">CA</span>
            <code className="font-[var(--font-jetbrains-mono)] text-[11px] text-[#3D4563] transition-colors group-hover:text-[#8B95B0]">
              {CA}
            </code>
            <span className="rounded-md bg-[#00FFB2]/10 px-2 py-0.5 text-[10px] font-bold text-[#00FFB2] transition-all group-hover:bg-[#00FFB2]/20">
              {copied ? "✓ Copied" : "Copy"}
            </span>
          </button>
        </div>
      </div>

      {/* Stats */}
      <ScrollReveal>
        <div className="relative mx-auto max-w-5xl px-4 pb-20">
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-xl">
            {[
              { label: "Markets", value: stats.markets, prefix: "", suffix: "", decimals: 0 },
              { label: "24h Volume", value: stats.volume / 1000, prefix: "$", suffix: "K", decimals: 0 },
              { label: "Insurance", value: stats.insurance / 1000, prefix: "$", suffix: "K", decimals: 0 },
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

      {/* How it works */}
      <div className="relative mx-auto max-w-5xl px-4 pb-20">
        <ScrollReveal>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.25em] text-[#00FFB2]/60">Protocol</div>
          <h2 className="mb-10 text-3xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
            Three steps. One click.
          </h2>
        </ScrollReveal>

        <div className="grid gap-4 md:grid-cols-3">
          {[
            { num: "01", title: "Pick Token", desc: "Paste any Solana token mint. Metadata and live price auto-fetched from Jupiter.", icon: "🎯" },
            { num: "02", title: "Set Params", desc: "Max leverage (2-20×), trading fees, initial liquidity. Full control.", icon: "⚙️" },
            { num: "03", title: "Deploy", desc: "Market goes live on-chain instantly. Share the link. Anyone can trade.", icon: "🚀" },
          ].map((item, i) => (
            <ScrollReveal key={item.num} delay={i * 0.15}>
              <GlassCard glow className="h-full">
                <div className="mb-4 flex items-center justify-between">
                  <span className="font-[var(--font-jetbrains-mono)] text-xs text-[#00FFB2]/40">{item.num}</span>
                  <span className="text-2xl">{item.icon}</span>
                </div>
                <h3 className="mb-2 text-lg font-bold text-white">{item.title}</h3>
                <p className="text-sm leading-relaxed text-[#8B95B0]">{item.desc}</p>
              </GlassCard>
            </ScrollReveal>
          ))}
        </div>
      </div>

      {/* Features bento */}
      <div className="relative mx-auto max-w-5xl px-4 pb-20">
        <ScrollReveal>
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.25em] text-[#7B61FF]/60">Features</div>
          <h2 className="mb-10 text-3xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
            Built different.
          </h2>
        </ScrollReveal>

        <div className="grid gap-4 md:grid-cols-2">
          {[
            { icon: "🔓", title: "Permissionless", desc: "No whitelisting. No governance. Anyone can deploy a market for any SPL token. Protocol is immutable.", accent: "#00FFB2" },
            { icon: "🔥", title: "Deflationary", desc: "Every trade pays fees into the insurance fund. Admin keys can be burned — fees permanently locked.", accent: "#FF4466" },
            { icon: "📊", title: "Real Leverage", desc: "Up to 20× on any token. Long or short with real on-chain settlement. Pure perpetual futures.", accent: "#7B61FF" },
            { icon: "⚡", title: "Solana Speed", desc: "Sub-second execution. Negligible gas. Automated keepers. Oracle prices from Jupiter/DexScreener.", accent: "#FFB800" },
          ].map((f, i) => (
            <ScrollReveal key={f.title} delay={i * 0.1}>
              <GlassCard hover glow={false} className="group h-full">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-white/[0.04] text-2xl transition-all duration-300 group-hover:scale-110 group-hover:bg-white/[0.08]" style={{ boxShadow: `0 0 20px ${f.accent}10` }}>
                  {f.icon}
                </div>
                <h3 className="mb-2 text-base font-bold text-white">{f.title}</h3>
                <p className="text-sm leading-relaxed text-[#8B95B0]">{f.desc}</p>
              </GlassCard>
            </ScrollReveal>
          ))}
        </div>
      </div>

      {/* Featured markets */}
      {featured.length > 0 && (
        <div className="relative mx-auto max-w-5xl px-4 pb-20">
          <ScrollReveal>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.25em] text-[#00FFB2]/60">Active</div>
            <h2 className="mb-8 text-3xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
              Top Markets
            </h2>
          </ScrollReveal>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {featured.map((m, i) => (
              <ScrollReveal key={m.slab_address} delay={i * 0.1}>
                <Link href={`/trade/${m.slab_address}`}>
                  <GlassCard hover glow className="group cursor-pointer">
                    <div className="mb-2 text-base font-bold text-white transition-colors group-hover:text-[#00FFB2]">
                      {m.symbol ? `${m.symbol}/USD` : `${m.slab_address.slice(0, 6)}…`}
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
      )}

      {/* Bottom CTA */}
      <ScrollReveal>
        <div className="relative mx-auto max-w-5xl px-4 pb-24">
          <div className="gradient-border rounded-2xl border border-white/[0.06] bg-white/[0.02] p-12 text-center backdrop-blur-xl md:p-16">
            <h2 className="mb-4 text-4xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
              Ready to launch?
            </h2>
            <p className="mb-8 text-[#8B95B0]">Deploy your own perpetual futures market in under 60 seconds.</p>
            <Link href="/create">
              <GlowButton size="lg">Launch a Market →</GlowButton>
            </Link>
          </div>
        </div>
      </ScrollReveal>

      {/* On-chain info */}
      <div className="relative mx-auto max-w-5xl px-4 pb-8">
        <div className="flex flex-wrap items-center justify-center gap-4 text-[11px] text-[#3D4563]">
          <span>
            Program:{" "}
            <a href={`https://explorer.solana.com/address/${cfg.programId}?cluster=${cfg.network}`} target="_blank" rel="noopener noreferrer" className="font-[var(--font-jetbrains-mono)] text-[#8B95B0] transition-colors hover:text-[#00FFB2]">
              {cfg.programId ? `${cfg.programId.slice(0, 6)}…${cfg.programId.slice(-6)}` : "Loading..."}
            </a>
          </span>
          <span className="text-[#1a2040]">|</span>
          <span>
            Token:{" "}
            <a href={`https://solscan.io/token/${CA}`} target="_blank" rel="noopener noreferrer" className="font-[var(--font-jetbrains-mono)] text-[#8B95B0] transition-colors hover:text-[#00FFB2]">
              {CA.slice(0, 6)}…{CA.slice(-4)}
            </a>
          </span>
          <span className="text-[#1a2040]">|</span>
          <span>
            Built on{" "}
            <a href="https://x.com/aaboroday" target="_blank" rel="noopener noreferrer" className="text-[#8B95B0] transition-colors hover:text-[#00FFB2]">
              toly&apos;s Percolator
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}
