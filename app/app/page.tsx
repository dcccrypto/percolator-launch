"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import { getSupabase } from "@/lib/supabase";
import { getConfig } from "@/lib/config";
import { AnimatedNumber } from "@/components/ui/AnimatedNumber";

const CA = "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump";

export default function Home() {
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState({ markets: 0, volume: 0, insurance: 0 });
  const [featured, setFeatured] = useState<{ slab_address: string; symbol: string | null; volume_24h: number; last_price: number | null; open_interest: number }[]>([]);
  const [cfg, setCfg] = useState<{ programId: string; network: string }>({ programId: "", network: "devnet" });
  const pageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const c = getConfig();
    setCfg({ programId: c.programId ?? "", network: c.network ?? "devnet" });
  }, []);

  useEffect(() => {
    if (!pageRef.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pageRef.current.style.opacity = "1";
      return;
    }
    gsap.fromTo(pageRef.current, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" });
  }, []);

  const copyCA = () => {
    navigator.clipboard.writeText(CA);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    async function loadStats() {
      const { data } = await getSupabase().from("markets_with_stats").select("slab_address, symbol, volume_24h, insurance_balance, last_price, open_interest") as { data: { slab_address: string; symbol: string | null; volume_24h: number | null; insurance_balance: number | null; last_price: number | null; open_interest: number | null }[] | null };
      if (data) {
        setStats({
          markets: data.length,
          volume: data.reduce((s, m) => s + (m.volume_24h || 0), 0),
          insurance: data.reduce((s, m) => s + (m.insurance_balance || 0), 0),
        });
        const sorted = [...data].sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0)).slice(0, 6);
        setFeatured(sorted.map((m) => ({
          slab_address: m.slab_address,
          symbol: m.symbol,
          volume_24h: m.volume_24h || 0,
          last_price: m.last_price,
          open_interest: m.open_interest || 0,
        })));
      }
    }
    loadStats();
  }, []);

  const hasStats = stats.markets > 0;
  const hasMarkets = featured.length > 0 && featured.some((m) => m.volume_24h > 0);

  return (
    <div ref={pageRef} className="gsap-fade">
      {/* Hero */}
      <div className="mx-auto max-w-3xl px-4 pt-32 pb-20 md:pt-44 md:pb-28">
        <h1
          className="text-6xl font-bold tracking-tight text-white md:text-8xl"
          style={{ fontFamily: "var(--font-space-grotesk)" }}
        >
          percolator
        </h1>
        <p className="mt-4 text-lg text-[#71717a] md:text-xl">
          perpetual futures for any token on solana.
        </p>
        <p className="mt-2 text-sm text-[#00FFB2]">yes, even that one.</p>

        <div className="mt-10 flex gap-3">
          <Link href="/create">
            <button className="rounded-[4px] bg-[#00FFB2] px-6 py-3 text-sm font-bold text-[#09090b] transition-opacity hover:opacity-85">
              launch a market
            </button>
          </Link>
          <Link href="/markets">
            <button className="rounded-[4px] border border-[#1a1a1f] px-6 py-3 text-sm font-semibold text-[#fafafa] transition-colors hover:border-[#3f3f46]">
              browse markets
            </button>
          </Link>
        </div>
      </div>

      {/* Stats */}
      {hasStats && (
        <div className="mx-auto max-w-3xl px-4 pb-20">
          <div className="flex items-center gap-6 text-sm text-[#71717a]">
            <span>
              <span className="font-mono text-white" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                <AnimatedNumber value={stats.markets} decimals={0} />
              </span>{" "}
              markets live
            </span>
            <span className="text-[#3f3f46]">&middot;</span>
            <span>
              <span className="font-mono text-white" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                <AnimatedNumber value={stats.volume / 1000} prefix="$" suffix="k" decimals={0} />
              </span>{" "}
              volume
            </span>
            <span className="text-[#3f3f46]">&middot;</span>
            <span>
              <span className="font-mono text-white" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                <AnimatedNumber value={stats.insurance / 1000} prefix="$" suffix="k" decimals={0} />
              </span>{" "}
              insured
            </span>
          </div>
        </div>
      )}

      {/* How it works */}
      <div className="mx-auto max-w-3xl px-4 pb-24">
        <h2 className="mb-10 text-xs font-medium uppercase tracking-[0.2em] text-[#71717a]">how it works</h2>

        <div className="space-y-12">
          <div>
            <h3 className="text-lg font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
              1. paste a token address
            </h3>
            <p className="mt-2 text-sm text-[#71717a]">any solana token. we auto-detect everything.</p>
          </div>
          <div>
            <h3 className="text-lg font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
              2. set your terms
            </h3>
            <p className="mt-2 text-sm text-[#71717a]">leverage, fees, initial liquidity. smart defaults if you don&apos;t care.</p>
          </div>
          <div>
            <h3 className="text-lg font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>
              3. congrats, you&apos;re a market maker now
            </h3>
            <p className="mt-2 text-sm text-[#71717a]">your market goes live instantly. share the link.</p>
          </div>
        </div>
      </div>

      {/* Features */}
      <div className="mx-auto max-w-3xl px-4 pb-24">
        <div className="grid gap-4 md:grid-cols-2">
          {[
            {
              title: "no permission needed",
              desc: "we didn't ask either. no governance, no whitelists, no waiting.",
            },
            {
              title: "fully on-chain",
              desc: "your keys, your leveraged degen positions. nothing custodial.",
            },
            {
              title: "insurance fund",
              desc: "for when someone inevitably gets rekt. every trade adds to it.",
            },
            {
              title: "burn the admin key",
              desc: "trust no one. not even us. one click and it's immutable forever.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="rounded-[4px] border border-[#1a1a1f] bg-[#111113] p-6"
            >
              <h3 className="text-sm font-bold text-white">{f.title}</h3>
              <p className="mt-2 text-sm text-[#71717a]">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Featured markets */}
      {hasMarkets && (
        <div className="mx-auto max-w-3xl px-4 pb-24">
          <h2 className="mb-6 text-xs font-medium uppercase tracking-[0.2em] text-[#71717a]">featured markets</h2>
          <div className="overflow-hidden rounded-[4px] border border-[#1a1a1f]">
            <div className="grid grid-cols-5 gap-4 border-b border-[#1a1a1f] bg-[#111113] px-4 py-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[#3f3f46]">
              <div>token</div>
              <div className="text-right">price</div>
              <div className="text-right">volume</div>
              <div className="text-right">OI</div>
              <div className="text-right">health</div>
            </div>
            {featured.map((m) => (
              <Link
                key={m.slab_address}
                href={`/trade/${m.slab_address}`}
                className="grid grid-cols-5 gap-4 px-4 py-3 text-sm transition-colors hover:bg-[#111113] border-b border-[#1a1a1f] last:border-b-0"
              >
                <div className="font-semibold text-white">
                  {m.symbol ? `${m.symbol}/USD` : `${m.slab_address.slice(0, 6)}...`}
                </div>
                <div className="text-right font-mono text-[#71717a]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                  {m.last_price != null
                    ? `$${m.last_price < 0.01 ? m.last_price.toFixed(6) : m.last_price < 1 ? m.last_price.toFixed(4) : m.last_price.toFixed(2)}`
                    : "—"}
                </div>
                <div className="text-right font-mono text-[#71717a]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                  {m.volume_24h >= 1000 ? `$${(m.volume_24h / 1000).toFixed(1)}k` : `$${m.volume_24h}`}
                </div>
                <div className="text-right font-mono text-[#71717a]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
                  {m.open_interest >= 1000 ? `$${(m.open_interest / 1000).toFixed(1)}k` : `$${m.open_interest}`}
                </div>
                <div className="text-right text-[#00FFB2]">--</div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Bottom CTA */}
      <div className="mx-auto max-w-3xl px-4 pb-24 text-center">
        <h2 className="text-2xl font-bold text-white" style={{ fontFamily: "var(--font-space-grotesk)" }}>ready?</h2>
        <div className="mt-6">
          <Link href="/create">
            <button className="rounded-[4px] bg-[#00FFB2] px-8 py-3 text-sm font-bold text-[#09090b] transition-opacity hover:opacity-85">
              launch a market
            </button>
          </Link>
        </div>
      </div>

      {/* Footer */}
      <div className="mx-auto max-w-3xl px-4 pb-8">
        <div className="flex items-center justify-center gap-4 border-t border-[#1a1a1f] pt-8 text-[11px] text-[#3f3f46]">
          <button onClick={copyCA} className="transition-colors hover:text-[#71717a]">
            <span className="font-mono" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
              {CA.slice(0, 8)}...{CA.slice(-6)}
            </span>
            {" "}{copied ? "copied" : "copy"}
          </button>
          <span>&middot;</span>
          <a href="https://github.com/dcccrypto/percolator-launch" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[#71717a]">github</a>
          <span>&middot;</span>
          <span>{cfg.network}</span>
          <span>&middot;</span>
          <a href="https://x.com/aaboroday" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[#71717a]">built on percolator engine</a>
        </div>
      </div>
    </div>
  );
}
