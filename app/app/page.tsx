"use client";

import Link from "next/link";
import { ButtonLink } from "@/components/ui/Button";
import { GlassCard } from "@/components/ui/GlassCard";
import { ScrollReveal } from "@/components/ui/ScrollReveal";
import { LiveMarketRail } from "@/components/landing/LiveMarketRail";

const ARROW = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

const PROOF_POINTS = [
  {
    index: "01",
    title: "Insurance fund on every market",
    body: "Each market seeds its own on-chain insurance pool before it can open. Bad debt eats the fund first — never the wrapper, never other traders.",
  },
  {
    index: "02",
    title: "Admin key can be burned",
    body: "Creators can permanently renounce admin control after launch. Once burned, no one can change config, pause the market, or touch its funds — it runs on its own code.",
  },
  {
    index: "03",
    title: "Deploy in ~60s",
    body: "Launch a perpetual market for any Solana token in one on-chain transaction. No listing committee, no gatekeeper.",
  },
  {
    index: "04",
    title: "Devnet — not real money",
    body: "This playground runs on Solana devnet with test funds. Claim sim-USDC from the faucet and trade freely, no risk.",
  },
];

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Connect & fund",
    body: "Connect a devnet wallet and claim sim-USDC from the faucet — one click, no signup.",
  },
  {
    step: "02",
    title: "Pick a market",
    body: "Trade any of the live markets below, or launch your own for any Solana token.",
  },
  {
    step: "03",
    title: "Go long or short",
    body: "Real oracle pricing, transparent liquidation math, up to 20x leverage.",
  },
];

export default function Home() {
  return (
    <div className="relative">
      {/* ─── Hero ─── */}
      <section className="mx-auto flex min-h-[calc(72dvh-3.5rem)] max-w-[1100px] flex-col justify-center px-6 py-20 sm:px-8">
        <ScrollReveal>
          <div className="mb-5 text-[11px] font-medium uppercase tracking-[0.25em] text-[var(--accent-text)]">
            // v17 · solana devnet
          </div>
        </ScrollReveal>

        <ScrollReveal delay={0.06}>
          <h1
            className="max-w-[16ch] text-balance text-[var(--text)]"
            style={{
              fontFamily: "var(--font-display)",
              fontSize: "var(--fs-display)",
              lineHeight: "var(--lh-display)",
              letterSpacing: "var(--ls-display)",
              fontWeight: 600,
            }}
          >
            Perpetual futures that can&apos;t rug you.
          </h1>
        </ScrollReveal>

        <ScrollReveal delay={0.12}>
          <p className="mt-6 max-w-[52ch] text-[15px] leading-relaxed text-[var(--text-secondary)]">
            Every market carries its own insurance fund, prices off live Solana DEX pools, and
            can burn its own admin key. Fully on-chain, permissionless, and open to any token.
          </p>
        </ScrollReveal>

        <ScrollReveal delay={0.18}>
          <div className="mt-10 flex flex-wrap items-center gap-6">
            <ButtonLink href="/trade" variant="primary" size="lg" iconRight={ARROW}>
              Start trading
            </ButtonLink>
            <Link
              href="/create"
              className="group inline-flex items-center gap-1.5 rounded-sm py-1.5 text-[12px] font-semibold uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
            >
              Launch a market in 60s
              <span aria-hidden="true" className="transition-transform duration-150 group-hover:translate-x-0.5">
                {ARROW}
              </span>
            </Link>
          </div>
        </ScrollReveal>
      </section>

      {/* ─── Live market rail ─── */}
      <section className="mx-auto max-w-[1100px] px-6 pb-20 sm:px-8">
        <ScrollReveal delay={0.05}>
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent-text)]">
              // live markets
            </h2>
            <Link
              href="/markets"
              className="group inline-flex items-center gap-1.5 rounded-sm py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
            >
              All markets
              <span aria-hidden="true" className="transition-transform duration-150 group-hover:translate-x-0.5">
                {ARROW}
              </span>
            </Link>
          </div>
        </ScrollReveal>
        <ScrollReveal delay={0.1}>
          <LiveMarketRail />
        </ScrollReveal>
      </section>

      {/* ─── Proof band ─── */}
      <section className="mx-auto max-w-[1100px] px-6 pb-20 sm:px-8">
        <ScrollReveal>
          <h2 className="mb-6 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent-text)]">
            // why it&apos;s different
          </h2>
        </ScrollReveal>
        {/* Cards are direct children of ScrollReveal (grid classes live on
            ScrollReveal itself) — `stagger` only staggers direct children;
            wrapping them in an extra grid <div> made `el.children.length`
            always 1, so the stagger silently no-op'd and every card faded
            in as one block. */}
        <ScrollReveal stagger={0.08} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PROOF_POINTS.map((p) => (
            <GlassCard key={p.index} padding="md" elevation="sm">
              <div className="mb-3 font-mono text-[11px] text-[var(--text-secondary)]">{p.index}</div>
              <h3 className="mb-2 text-[13px] font-semibold leading-snug text-[var(--text)]">{p.title}</h3>
              <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">{p.body}</p>
            </GlassCard>
          ))}
        </ScrollReveal>
      </section>

      {/* ─── How it works ─── */}
      <section className="mx-auto max-w-[1100px] px-6 pb-24 sm:px-8">
        <ScrollReveal>
          <h2 className="mb-6 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent-text)]">
            // how it works
          </h2>
        </ScrollReveal>

        {/* Steps are direct children of ScrollReveal — see proof-band comment
            above for why the stagger needs this instead of a nested grid <div>. */}
        <ScrollReveal stagger={0.08} className="grid grid-cols-1 gap-8 sm:grid-cols-3">
          {HOW_IT_WORKS.map((s) => (
            <div key={s.step} className="border-t border-[var(--border)] pt-4">
              <div className="mb-2 font-mono text-[11px] text-[var(--accent-text)]">{s.step}</div>
              <h3 className="mb-1.5 text-[14px] font-semibold text-[var(--text)]">{s.title}</h3>
              <p className="text-[13px] leading-relaxed text-[var(--text-secondary)]">{s.body}</p>
            </div>
          ))}
        </ScrollReveal>

        <ScrollReveal delay={0.15}>
          <div className="mt-14 flex flex-col items-start gap-4 border-t border-[var(--border)] pt-8 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[13px] text-[var(--text-secondary)]">
              Browse every live market, or launch one for a token that doesn&apos;t have a perp yet.
            </p>
            <div className="flex shrink-0 items-center gap-4">
              <ButtonLink href="/markets" variant="secondary" size="md">
                Browse markets
              </ButtonLink>
              <ButtonLink href="/create" variant="primary" size="md" iconRight={ARROW}>
                Launch market
              </ButtonLink>
            </div>
          </div>
        </ScrollReveal>
      </section>
    </div>
  );
}
