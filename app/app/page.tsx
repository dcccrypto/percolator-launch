"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

const CA = "8PzFWyLpCVEmbZmVJcaRTU5r69XKJx1rd7YGpWvnpump";

export default function Home() {
  const [copied, setCopied] = useState(false);
  const [stats, setStats] = useState({ markets: 0, volume: 0, insurance: 0 });
  const [featured, setFeatured] = useState<{ slab_address: string; symbol: string | null; volume_total: number }[]>([]);

  const copyCA = () => {
    navigator.clipboard.writeText(CA);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    async function loadStats() {
      const { data } = await supabase.from("markets_with_stats").select("slab_address, symbol, volume_total, insurance_fund");
      if (data) {
        setStats({
          markets: data.length,
          volume: data.reduce((s, m) => s + (m.volume_total || 0), 0),
          insurance: data.reduce((s, m) => s + (m.insurance_fund || 0), 0),
        });
        const sorted = [...data].sort((a, b) => (b.volume_total || 0) - (a.volume_total || 0)).slice(0, 4);
        setFeatured(sorted.map((m) => ({ slab_address: m.slab_address, symbol: m.symbol, volume_total: m.volume_total || 0 })));
      }
    }
    loadStats();
  }, []);

  return (
    <div className="relative overflow-hidden terminal-grid">
      {/* Background effects */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 -translate-x-1/2 h-[800px] w-[1000px] rounded-full bg-[#00d4aa]/3 blur-[200px]" />
        <div className="absolute left-0 top-1/4 h-[400px] w-[400px] rounded-full bg-[#00d4aa]/2 blur-[150px]" />
      </div>

      {/* Hero */}
      <div className="relative mx-auto max-w-5xl px-4 pb-16 pt-20 md:pt-28">
        <div className="text-center">
          {/* Live badge */}
          <div className="mb-6 inline-flex items-center gap-2 rounded-full bg-[#00d4aa]/5 px-4 py-1.5 text-[12px] font-medium text-[#00d4aa] ring-1 ring-[#00d4aa]/15">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#00d4aa] opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#00d4aa]" />
            </span>
            Live on Solana
          </div>

          {/* Title */}
          <h1 className="mb-4 text-5xl font-extrabold tracking-tight text-white md:text-7xl lg:text-8xl">
            <span className="bg-gradient-to-r from-white via-white to-[#00d4aa]/80 bg-clip-text text-transparent">
              Percolator
            </span>
          </h1>
          <p className="mx-auto mb-3 max-w-lg text-lg font-medium text-[#b0b7c8] md:text-xl">
            Permissionless perpetual futures on Solana
          </p>
          <p className="mx-auto mb-8 max-w-xl text-sm text-[#4a5068]">
            Deploy a leveraged perp market for any SPL token in one click.
            Up to 20× leverage. No governance. No permission.
          </p>

          {/* CTAs */}
          <div className="mb-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/launch"
              className="group rounded-xl bg-[#00d4aa] px-8 py-3.5 text-sm font-bold text-[#080a0f] transition-all hover:bg-[#00e8bb] hover:shadow-[0_0_30px_rgba(0,212,170,0.2)]"
            >
              Launch a Market →
            </Link>
            <Link
              href="/markets"
              className="rounded-xl bg-[#0f1118] px-8 py-3.5 text-sm font-semibold text-[#b0b7c8] ring-1 ring-[#1a1d2a] transition-all hover:bg-[#131620] hover:ring-[#252a3a]"
            >
              Browse Markets
            </Link>
          </div>

          {/* CA */}
          <button
            onClick={copyCA}
            className="group mx-auto flex items-center gap-2.5 rounded-lg bg-[#0f1118] px-4 py-2 ring-1 ring-[#1a1d2a] transition-all hover:ring-[#00d4aa]/20"
          >
            <span className="text-[10px] font-bold tracking-widest text-[#00d4aa]">CA</span>
            <code className="data-cell text-[11px] text-[#4a5068] transition-colors group-hover:text-[#7a8194]">
              {CA}
            </code>
            <span className="rounded bg-[#00d4aa]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#00d4aa]">
              {copied ? "✓" : "Copy"}
            </span>
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="relative mx-auto max-w-5xl px-4 pb-16">
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-[#1a1d2a] ring-1 ring-[#1a1d2a]">
          {[
            { label: "Markets", value: stats.markets || "—" },
            { label: "Volume", value: stats.volume ? `$${(stats.volume / 1000).toFixed(0)}K` : "—" },
            { label: "Insurance", value: stats.insurance ? `$${(stats.insurance / 1000).toFixed(0)}K` : "—" },
          ].map((s) => (
            <div key={s.label} className="bg-[#0c0e14] p-6 text-center">
              <p className="data-cell text-2xl font-bold text-white md:text-3xl">{s.value}</p>
              <p className="mt-1 text-[11px] font-medium uppercase tracking-widest text-[#4a5068]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* How it works */}
      <div className="relative mx-auto max-w-5xl px-4 pb-16">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-[#00d4aa]/60">Protocol</div>
        <h2 className="mb-8 text-2xl font-bold text-white">Three steps. One click.</h2>

        <div className="grid gap-px overflow-hidden rounded-xl bg-[#1a1d2a] md:grid-cols-3">
          {[
            { num: "01", title: "Pick Token", desc: "Paste any Solana token mint. Metadata and live price auto-fetched from Jupiter." },
            { num: "02", title: "Set Params", desc: "Max leverage (2-20×), trading fees, initial liquidity. Full control." },
            { num: "03", title: "Deploy", desc: "Market goes live on-chain instantly. Share the link. Anyone can trade." },
          ].map((item) => (
            <div key={item.num} className="group bg-[#0c0e14] p-8 transition-colors hover:bg-[#0f1118]">
              <div className="mb-4 data-cell text-xs text-[#00d4aa]/40">{item.num}</div>
              <h3 className="mb-2 text-base font-bold text-white">{item.title}</h3>
              <p className="text-[13px] leading-relaxed text-[#4a5068]">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Featured markets */}
      {featured.length > 0 && (
        <div className="relative mx-auto max-w-5xl px-4 pb-16">
          <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-[#00d4aa]/60">Active</div>
          <h2 className="mb-6 text-2xl font-bold text-white">Top Markets</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {featured.map((m) => (
              <Link
                key={m.slab_address}
                href={`/trade/${m.slab_address}`}
                className="group rounded-xl bg-[#0c0e14] p-5 ring-1 ring-[#1a1d2a] transition-all hover:ring-[#00d4aa]/20 hover:bg-[#0f1118]"
              >
                <div className="mb-1.5 text-sm font-bold text-white group-hover:text-[#00d4aa]">
                  {m.symbol ? `${m.symbol}/USD` : `${m.slab_address.slice(0, 6)}…`}
                </div>
                <div className="data-cell text-xs text-[#4a5068]">
                  Vol: <span className="text-[#7a8194]">{m.volume_total >= 1000 ? `$${(m.volume_total / 1000).toFixed(1)}K` : `$${m.volume_total.toLocaleString()}`}</span>
                </div>
                <div className="mt-2 text-[11px] font-medium text-[#00d4aa] opacity-0 transition-opacity group-hover:opacity-100">
                  Trade →
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Features grid */}
      <div className="relative mx-auto max-w-5xl px-4 pb-16">
        <div className="grid gap-3 md:grid-cols-2">
          {[
            { icon: "🔓", title: "Permissionless", desc: "No whitelisting. No governance. Anyone can deploy a market for any SPL token. Protocol is immutable." },
            { icon: "🔥", title: "Deflationary", desc: "Every trade pays fees into the insurance fund. Admin keys can be burned — fees permanently locked." },
            { icon: "📊", title: "Real Leverage", desc: "Up to 20× on any token. Long or short with real on-chain settlement. Pure perpetual futures." },
            { icon: "⚡", title: "Solana Speed", desc: "Sub-second execution. Negligible gas. Automated keepers. Oracle prices from Jupiter/DexScreener." },
          ].map((f) => (
            <div key={f.title} className="rounded-xl bg-[#0c0e14] p-6 ring-1 ring-[#1a1d2a] transition-colors hover:bg-[#0f1118]">
              <div className="mb-3 text-xl">{f.icon}</div>
              <h3 className="mb-2 text-sm font-bold text-white">{f.title}</h3>
              <p className="text-[13px] leading-relaxed text-[#4a5068]">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom CTA */}
      <div className="relative mx-auto max-w-5xl px-4 pb-20">
        <div className="rounded-xl bg-gradient-to-b from-[#00d4aa]/5 to-transparent p-12 text-center ring-1 ring-[#00d4aa]/10">
          <h2 className="mb-3 text-3xl font-extrabold text-white">Ready to launch?</h2>
          <p className="mb-6 text-sm text-[#4a5068]">Deploy your own perpetual futures market in under 60 seconds.</p>
          <Link
            href="/launch"
            className="inline-block rounded-xl bg-[#00d4aa] px-10 py-3.5 text-sm font-bold text-[#080a0f] transition-all hover:bg-[#00e8bb] hover:shadow-[0_0_30px_rgba(0,212,170,0.2)]"
          >
            Launch a Market →
          </Link>
        </div>
      </div>

      {/* On-chain info */}
      <div className="relative mx-auto max-w-5xl px-4 pb-8">
        <div className="flex flex-wrap items-center justify-center gap-4 text-[11px] text-[#2a2f40]">
          <span>
            Program:{" "}
            <a href="https://solscan.io/account/GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24" target="_blank" rel="noopener noreferrer" className="data-cell text-[#4a5068] hover:text-[#00d4aa]">
              GM8zjJ…Y3rY24
            </a>
          </span>
          <span className="text-[#1a1d2a]">|</span>
          <span>
            Token:{" "}
            <a href={`https://solscan.io/token/${CA}`} target="_blank" rel="noopener noreferrer" className="data-cell text-[#4a5068] hover:text-[#00d4aa]">
              {CA.slice(0, 6)}…{CA.slice(-4)}
            </a>
          </span>
          <span className="text-[#1a1d2a]">|</span>
          <span>
            Built on{" "}
            <a href="https://x.com/aaboroday" target="_blank" rel="noopener noreferrer" className="text-[#4a5068] hover:text-[#00d4aa]">
              toly&apos;s Percolator
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}
