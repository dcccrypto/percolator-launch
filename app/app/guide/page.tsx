"use client";

import Link from "next/link";
import { ScrollReveal } from "@/components/ui/ScrollReveal";

const sectionHeader = "mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60";
const sectionTitle = "text-lg font-semibold tracking-[-0.01em] text-white sm:text-xl";
const cardClass = "border border-[var(--border)] bg-[var(--panel-bg)]";
const cellClass = "px-4 py-3 text-[12px]";
const thClass = "px-4 py-3 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-muted)] text-left";

function Section({ id, tag, title, children }: { id: string; tag: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-4 scroll-mt-20">
      <div>
        <div className={sectionHeader}>// {tag}</div>
        <h2 className={sectionTitle} style={{ fontFamily: "var(--font-heading)" }}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

export default function GuidePage() {
  const sections = [
    { id: "overview", label: "What is Percolator?" },
    { id: "environments", label: "Devnet vs Mainnet" },
    { id: "mechanics", label: "How Markets Work" },
    { id: "oracles", label: "Oracle Modes" },
    { id: "capacity", label: "Market Tiers" },
    { id: "quickstart", label: "Getting Started" },
    { id: "faq", label: "FAQ" },
  ];

  return (
    <div className="min-h-[calc(100vh-48px)] relative">
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />
    <div className="relative mx-auto max-w-4xl px-4 py-10 space-y-16">
      {/* Header */}
      <ScrollReveal>
        <div className="mb-8">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
            // documentation
          </div>
          <h1
            className="text-xl font-medium tracking-[-0.01em] text-white sm:text-2xl"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            <span className="font-normal text-white/50">Percolator </span>Guide
          </h1>
          <p className="mt-2 text-[13px] text-[var(--text-secondary)]">
            Everything you need to know about launching and trading perpetual futures markets on Solana.
          </p>
        </div>
      </ScrollReveal>

      {/* P-MED-6: Table of Contents */}
      <ScrollReveal>
        <nav className={`${cardClass} p-5`}>
          <h2 className="text-sm font-semibold text-white mb-3 uppercase tracking-wider">Contents</h2>
          <ul className="space-y-2">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="text-[13px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors flex items-center gap-2 group"
                >
                  <svg className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </ScrollReveal>

      {/* What is Percolator */}
      <Section id="overview" tag="overview" title="What is Percolator?">
        <div className={cardClass}>
          <div className="p-5 space-y-3">
            <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
              Percolator is <span className="text-white font-medium">pump.fun for perps</span> — anyone can launch a perpetual futures market for any Solana token in one click. No approvals, no gatekeepers.
            </p>
            <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">
              Paste a token address, set your terms, and your market goes live on-chain instantly. Traders can open leveraged long/short positions using the token itself as collateral.
            </p>
          </div>
        </div>
      </Section>

      {/* Devnet vs Mainnet */}
      <Section id="environments" tag="environments" title="Devnet vs Mainnet">
        <div className={`${cardClass} overflow-x-auto`}>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--bg-surface)]">
                <th className={thClass}>Aspect</th>
                <th className={thClass}>Devnet</th>
                <th className={thClass}>Mainnet</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {[
                ["Oracle", "Admin pushes prices manually", "Live Pyth / DexScreener / Jupiter feeds"],
                ["Tokens", "Test tokens from faucet", "Real SPL tokens with DEX pools"],
                ["SOL", "Free from faucet", "Real SOL"],
                ["Risk", "Play money — test freely", "Real money at risk"],
                ["Markets", "Anyone can create (free)", "Anyone can create (~$65+ rent cost)"],
              ].map(([aspect, devnet, mainnet]) => (
                <tr key={aspect} className="transition-colors hover:bg-[var(--bg-elevated)]">
                  <td className={`${cellClass} font-medium text-white`}>{aspect}</td>
                  <td className={`${cellClass} text-[var(--warning)]`}>{devnet}</td>
                  <td className={`${cellClass} text-[var(--cyan)]`}>{mainnet}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* How Markets Work */}
      <Section id="mechanics" tag="mechanics" title="How Markets Work">
        <div className="grid grid-cols-1 gap-px overflow-hidden border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2">
          {[
            {
              title: "Coin-Margined",
              desc: "You deposit the same token you are trading as collateral — not USDC or SOL. Each market is isolated to its own token.",
            },
            {
              title: "vAMM Liquidity",
              desc: "LP provides liquidity via a virtual AMM (matcher program). The vAMM determines spread and price impact based on configurable parameters.",
            },
            {
              title: "Crank Service",
              desc: "An off-chain crank processes funding rate payments, liquidations, and PnL settlements on a regular cadence.",
            },
            {
              title: "Insurance Fund",
              desc: "Each market has an insurance fund that absorbs losses from liquidations, protecting the system against socialized losses.",
            },
          ].map((item) => (
            <div key={item.title} className="bg-[var(--panel-bg)] p-5 transition-colors hover:bg-[var(--bg-elevated)]">
              <h3 className="text-[13px] font-semibold text-white mb-2">{item.title}</h3>
              <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">{item.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* Oracle Modes */}
      <Section id="oracles" tag="oracles" title="Oracle Modes">
        <div className="border border-[var(--border)] divide-y divide-[var(--border)]">
          {[
            {
              mode: "Admin Oracle",
              env: "devnet",
              color: "var(--warning)",
              desc: "Market creator pushes prices manually from the My Markets page. Ideal for testing. The oracle authority can be transferred or delegated to the crank service.",
            },
            {
              mode: "Pyth Oracle",
              env: "mainnet",
              color: "var(--accent)",
              desc: "Automatic real-time prices from the Pyth network. Set the Pyth feed ID during market creation. Supports hundreds of Solana tokens.",
            },
            {
              mode: "DexScreener / Jupiter",
              env: "mainnet",
              color: "var(--cyan)",
              desc: "Auto-detected for tokens with DEX pools (PumpSwap, Raydium, Meteora). No configuration needed — the pool address is used as the price source.",
            },
          ].map((item) => (
            <div key={item.mode} className="bg-[var(--panel-bg)] p-5 flex items-start gap-4">
              <div
                className="mt-0.5 h-2 w-2 flex-shrink-0 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-[13px] font-semibold text-white">{item.mode}</h3>
                  <span
                    className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider border"
                    style={{ color: item.color, borderColor: `color-mix(in srgb, ${item.color} 30%, transparent)` }}
                  >
                    {item.env}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Market Tiers */}
      <Section id="capacity" tag="capacity" title="Market Tiers">
        <div className={`${cardClass} overflow-x-auto`}>
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--bg-surface)]">
                <th className={thClass}>Tier</th>
                <th className={thClass}>Trader Slots</th>
                <th className={thClass}>Approx. Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {[
                ["Small", "256", "~$65 (~0.44 SOL)"],
                ["Medium", "1,024", "~$260 (~1.8 SOL)"],
                ["Large", "4,096", "~$1,000 (~7 SOL)"],
              ].map(([tier, slots, cost]) => (
                <tr key={tier} className="transition-colors hover:bg-[var(--bg-elevated)]">
                  <td className={`${cellClass} font-medium text-white`}>{tier}</td>
                  <td className={`${cellClass} text-[var(--text-secondary)]`}>{slots}</td>
                  <td className={`${cellClass} text-[var(--text-secondary)]`}>{cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-[var(--text-dim)]">
          Costs are rent deposits (recoverable if market is closed). Prices approximate at current SOL rates.
        </p>
      </Section>

      {/* Getting Started */}
      <Section id="quickstart" tag="quickstart" title="Getting Started on Devnet">
        <div className="border border-[var(--border)] divide-y divide-[var(--border)]">
          {[
            { step: "01", title: "Connect Phantom", desc: "Open Phantom wallet settings and switch network to Devnet." },
            { step: "02", title: "Get Test SOL", desc: "Use the Solana faucet or run 'solana airdrop 2' in your terminal to get free devnet SOL." },
            { step: "03", title: "Create a Test Token", desc: "Go to /devnet-mint to create a test SPL token with configurable supply and decimals." },
            { step: "04", title: "Launch a Market", desc: "Go to /create, paste your token mint, and use Quick Launch. With no DEX pool, it defaults to admin oracle mode." },
            { step: "05", title: "Push Oracle Prices", desc: "Go to /my-markets. Click 'push price' on your market to set the oracle price manually." },
            { step: "06", title: "Open Trades", desc: "Navigate to the trade page, deposit collateral, and open your first leveraged position." },
          ].map((item) => (
            <div key={item.step} className="bg-[var(--panel-bg)] flex items-start gap-4 p-5 transition-colors hover:bg-[var(--bg-elevated)]">
              <span
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center border border-[var(--accent)]/20 bg-[var(--accent)]/[0.04] text-[11px] font-bold text-[var(--accent)]"
              >
                {item.step}
              </span>
              <div>
                <h3 className="text-[13px] font-semibold text-white">{item.title}</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-secondary)]">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq" tag="faq" title="Frequently Asked Questions">
        <div className="border border-[var(--border)] divide-y divide-[var(--border)]">
          {[
            {
              q: "What happens if the oracle price is not updated?",
              a: "The crank service will detect stale prices. On admin oracle markets, you must push prices manually. If the price is too stale, trading may be paused automatically.",
            },
            {
              q: "Can I recover the rent from a market?",
              a: "The slab account rent is recoverable if the market is fully closed and all positions are settled. Admin can close the market through on-chain instructions.",
            },
            {
              q: "What is the insurance fund for?",
              a: "The insurance fund absorbs losses from underwater liquidations. If a position is liquidated below zero, the insurance fund covers the deficit instead of socializing the loss across other traders.",
            },
            {
              q: "Can I use any Solana token?",
              a: "Yes. Any SPL token with a valid mint can be used as collateral. For mainnet, the token should have a DEX pool or Pyth feed for live pricing.",
            },
            {
              q: "What is coin-margined trading?",
              a: "Unlike USDC-margined perps, you post the token itself as collateral. If you are trading a WIF perp, you deposit WIF. Your PnL is also settled in WIF.",
            },
            {
              q: "How do I switch between devnet and mainnet?",
              a: "Click the network badge in the header to toggle. Your wallet must also be set to the matching network in its settings.",
            },
          ].map((item, idx) => (
            <details key={idx} className="bg-[var(--panel-bg)] group">
              <summary className="cursor-pointer px-5 py-4 text-[13px] font-medium text-white transition-colors hover:bg-[var(--bg-elevated)] list-none flex items-center justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/50">
                {item.q}
                <svg className="h-3 w-3 text-[var(--text-muted)] transition-transform group-open:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </summary>
              <div className="border-t border-[var(--border)] px-5 py-4">
                <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">{item.a}</p>
              </div>
            </details>
          ))}
        </div>
      </Section>

      {/* CTA */}
      <div className="text-center space-y-4 pb-8">
        <div className="flex justify-center gap-3">
          <Link
            href="/create"
            className="border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-6 py-3 text-[12px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all hud-btn-corners hover:border-[var(--accent)] hover:bg-[var(--accent)]/[0.15]"
          >
            Launch a Market
          </Link>
          <Link
            href="/markets"
            className="border border-[var(--border)] px-6 py-3 text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all hover:border-[var(--accent)]/30 hover:text-white"
          >
            Browse Markets
          </Link>
        </div>
      </div>
    </div>
    </div>
  );
}
