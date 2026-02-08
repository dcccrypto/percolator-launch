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
        // Top 3 by volume
        const sorted = [...data].sort((a, b) => (b.volume_total || 0) - (a.volume_total || 0)).slice(0, 3);
        setFeatured(sorted.map((m) => ({ slab_address: m.slab_address, symbol: m.symbol, volume_total: m.volume_total || 0 })));
      }
    }
    loadStats();
  }, []);

  return (
    <div className="relative overflow-hidden">
      {/* Background glow effects */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 -translate-x-1/2 h-[600px] w-[800px] rounded-full bg-emerald-500/5 blur-[120px]" />
        <div className="absolute right-0 top-1/3 h-[400px] w-[400px] rounded-full bg-emerald-500/3 blur-[100px]" />
      </div>

      {/* Hero */}
      <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-20 md:pt-32">
        <div className="text-center">
          {/* Badge */}
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/5 px-5 py-2 text-sm text-emerald-400 backdrop-blur-sm">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            Live on Solana Mainnet
          </div>

          {/* Title */}
          <h1 className="mb-6 text-6xl font-extrabold tracking-tight text-white md:text-8xl">
            Percolator
          </h1>
          <p className="mx-auto mb-4 max-w-xl text-xl font-medium text-slate-300 md:text-2xl">
            Trade any token with leverage. No permission needed.
          </p>
          <p className="mx-auto mb-10 max-w-2xl text-base text-slate-500">
            Deploy a leveraged perpetual futures market on Solana in one click.
            No smart contract. No governance. Just paste a token mint and go.
          </p>

          {/* CTA */}
          <div className="mb-12 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/launch"
              className="group relative overflow-hidden rounded-2xl bg-emerald-500 px-10 py-4 text-base font-bold text-white transition-all hover:bg-emerald-400 hover:shadow-2xl hover:shadow-emerald-500/20"
            >
              <span className="relative z-10">Launch a Market →</span>
            </Link>
            <Link
              href="/markets"
              className="rounded-2xl border border-[#1e2433] bg-[#111318]/80 px-10 py-4 text-base font-semibold text-slate-300 backdrop-blur-sm transition-all hover:border-slate-600 hover:bg-[#1a1d24]"
            >
              Browse Markets
            </Link>
          </div>

          {/* CA */}
          <button
            onClick={copyCA}
            className="group mx-auto flex items-center gap-3 rounded-2xl border border-[#1e2433] bg-[#111318]/60 px-6 py-3 backdrop-blur-sm transition-all hover:border-emerald-500/30 hover:bg-[#111318]"
          >
            <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-400">CA</span>
            <code className="font-mono text-xs text-slate-400 transition-colors group-hover:text-slate-200 sm:text-sm">
              {CA}
            </code>
            <span className="rounded-lg bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400 transition-colors group-hover:bg-emerald-500/20">
              {copied ? "✓" : "Copy"}
            </span>
          </button>
        </div>
      </div>

      {/* How it works */}
      <div className="relative mx-auto max-w-6xl px-4 pb-20">
        <h2 className="mb-4 text-center text-sm font-bold uppercase tracking-widest text-emerald-400">
          How it works
        </h2>
        <p className="mb-12 text-center text-3xl font-bold text-white">
          Three steps. One click.
        </p>

        <div className="grid gap-px overflow-hidden rounded-3xl border border-[#1e2433] bg-[#1e2433] md:grid-cols-3">
          {[
            {
              num: "01",
              icon: "🪙",
              title: "Pick a Token",
              desc: "Paste any Solana token mint. We auto-fetch metadata and pull the live price from Jupiter.",
            },
            {
              num: "02",
              icon: "⚙️",
              title: "Set Parameters",
              desc: "Choose max leverage (2-20x), trading fees, and seed your initial liquidity pool.",
            },
            {
              num: "03",
              icon: "⚡",
              title: "Deploy & Trade",
              desc: "Market goes live on-chain instantly. Share the link. Anyone can trade it.",
            },
          ].map((item) => (
            <div key={item.num} className="group bg-[#0a0b0f] p-10 transition-colors hover:bg-[#0d0e13]">
              <div className="mb-6 flex items-center gap-3">
                <span className="text-2xl">{item.icon}</span>
                <span className="font-mono text-xs text-slate-600">{item.num}</span>
              </div>
              <h3 className="mb-3 text-xl font-bold text-white">{item.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="relative mx-auto max-w-6xl px-4 pb-20">
        <div className="grid gap-px overflow-hidden rounded-3xl border border-[#1e2433] bg-[#1e2433] md:grid-cols-3">
          {[
            { label: "Markets Deployed", value: stats.markets || "—" },
            { label: "Total Volume", value: stats.volume ? `$${(stats.volume / 1000).toFixed(0)}K` : "—" },
            { label: "Insurance Locked", value: stats.insurance ? `$${(stats.insurance / 1000).toFixed(0)}K` : "—" },
          ].map((s) => (
            <div key={s.label} className="bg-[#0a0b0f] p-10 text-center">
              <p className="text-4xl font-extrabold text-white">{s.value}</p>
              <p className="mt-2 text-sm font-medium text-slate-500">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Featured Markets */}
      {featured.length > 0 && (
        <div className="relative mx-auto max-w-6xl px-4 pb-20">
          <h2 className="mb-4 text-center text-sm font-bold uppercase tracking-widest text-emerald-400">
            Featured Markets
          </h2>
          <p className="mb-8 text-center text-2xl font-bold text-white">
            Top markets by volume
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            {featured.map((m) => (
              <Link
                key={m.slab_address}
                href={`/trade/${m.slab_address}`}
                className="group rounded-2xl border border-[#1e2433] bg-[#111318] p-6 transition-all duration-200 hover:border-emerald-500/30 hover:bg-[#1a1d24] hover:shadow-lg hover:shadow-emerald-500/5"
              >
                <div className="mb-2 text-lg font-bold text-white group-hover:text-emerald-300">
                  {m.symbol ? `${m.symbol}/USD` : `${m.slab_address.slice(0, 6)}...`}
                </div>
                <div className="text-sm text-slate-400">
                  Volume: <span className="font-mono text-slate-200">{m.volume_total >= 1000 ? `$${(m.volume_total / 1000).toFixed(1)}K` : `$${m.volume_total.toLocaleString()}`}</span>
                </div>
                <div className="mt-3 text-xs font-medium text-emerald-400 opacity-0 transition-opacity group-hover:opacity-100">
                  Trade →
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Features */}
      <div className="relative mx-auto max-w-6xl px-4 pb-20">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-3xl border border-[#1e2433] bg-[#111318] p-10">
            <div className="mb-4 text-3xl">🔒</div>
            <h3 className="mb-3 text-xl font-bold text-white">Permissionless</h3>
            <p className="text-sm leading-relaxed text-slate-400">
              No whitelisting. No governance votes. No approvals. Anyone can deploy a market for any SPL token.
              The protocol is immutable — deployed on toly&apos;s Percolator program.
            </p>
          </div>
          <div className="rounded-3xl border border-[#1e2433] bg-[#111318] p-10">
            <div className="mb-4 text-3xl">🔥</div>
            <h3 className="mb-3 text-xl font-bold text-white">Deflationary by Design</h3>
            <p className="text-sm leading-relaxed text-slate-400">
              Every trade pays fees into the insurance fund. Admin keys can be burned —
              making fees permanently locked. More trading = more tokens removed from circulation.
            </p>
          </div>
          <div className="rounded-3xl border border-[#1e2433] bg-[#111318] p-10">
            <div className="mb-4 text-3xl">📊</div>
            <h3 className="mb-3 text-xl font-bold text-white">Real Leverage</h3>
            <p className="text-sm leading-relaxed text-slate-400">
              Up to 20x leverage on any token. Long or short with real on-chain settlement.
              No synthetic assets — pure perpetual futures backed by collateral.
            </p>
          </div>
          <div className="rounded-3xl border border-[#1e2433] bg-[#111318] p-10">
            <div className="mb-4 text-3xl">⚡</div>
            <h3 className="mb-3 text-xl font-bold text-white">Solana Speed</h3>
            <p className="text-sm leading-relaxed text-slate-400">
              Sub-second trade execution. Negligible gas fees. Automated keeper bots crank funding rates.
              Oracle prices pushed from Jupiter/DexScreener in real-time.
            </p>
          </div>
        </div>
      </div>

      {/* Bottom CTA */}
      <div className="relative mx-auto max-w-6xl px-4 pb-24">
        <div className="rounded-3xl border border-emerald-500/20 bg-gradient-to-b from-emerald-500/5 to-transparent p-16 text-center">
          <h2 className="mb-4 text-4xl font-extrabold text-white">
            Ready to launch?
          </h2>
          <p className="mb-8 text-slate-400">
            Deploy your own perpetual futures market in under 60 seconds.
          </p>
          <Link
            href="/launch"
            className="inline-block rounded-2xl bg-emerald-500 px-12 py-4 text-base font-bold text-white transition-all hover:bg-emerald-400 hover:shadow-2xl hover:shadow-emerald-500/20"
          >
            Launch a Market →
          </Link>
        </div>
      </div>

      {/* On-chain footer info */}
      <div className="relative mx-auto max-w-6xl px-4 pb-12">
        <div className="flex flex-wrap items-center justify-center gap-6 text-xs text-slate-600">
          <span>
            Program:{" "}
            <a
              href="https://solscan.io/account/GM8zjJ8LTBMv9xEsverh6H6wLyevgMHEJXcEzyY3rY24"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-slate-500 hover:text-emerald-400"
            >
              GM8zjJ...Y3rY24
            </a>
          </span>
          <span className="text-slate-700">|</span>
          <span>
            Token:{" "}
            <a
              href={`https://solscan.io/token/${CA}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-slate-500 hover:text-emerald-400"
            >
              {CA.slice(0, 6)}...{CA.slice(-4)}
            </a>
          </span>
          <span className="text-slate-700">|</span>
          <span>
            Built on{" "}
            <a
              href="https://x.com/aaboroday"
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-500 hover:text-emerald-400"
            >
              toly&apos;s Percolator
            </a>
          </span>
        </div>
      </div>
    </div>
  );
}
