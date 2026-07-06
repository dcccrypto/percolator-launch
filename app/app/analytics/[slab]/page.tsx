"use client";

/**
 * Phase 3 (trade-terminal rebuild): deep-analytics route.
 *
 * These cards used to live inline on /trade/[slab], contributing to the
 * "~20 mounted components, not ~5" problem documented in BUILD-LOG.md
 * Phase 0/3 — most traders never look at engine/crank/insurance internals
 * on every visit, but the old page paid the mount+subscribe cost for all of
 * them unconditionally. Moved here as a dedicated, opt-in route instead of
 * a collapsed drawer (simpler, no half-mounted-drawer edge cases, and a
 * shareable/bookmarkable URL for the handful of users — LPs, market
 * creators, curious traders — who do want this view).
 */

import { use } from "react";
import { PublicKey } from "@solana/web3.js";
import { SlabProvider, useSlabState } from "@/components/providers/SlabProvider";
import { UsdToggleProvider } from "@/components/providers/UsdToggleProvider";
import { EngineHealthCard } from "@/components/trade/EngineHealthCard";
import { CrankHealthCard } from "@/components/trade/CrankHealthCard";
import { OpenInterestCard } from "@/components/market/OpenInterestCard";
import { InsuranceDashboard } from "@/components/market/InsuranceDashboard";
import { LiquidationAnalytics } from "@/components/trade/LiquidationAnalytics";
import { SystemCapitalCard } from "@/components/trade/SystemCapitalCard";
import { AdlLeaderboard } from "@/components/trade/AdlLeaderboard";
import { AccountsCard } from "@/components/trade/AccountsCard";
import { MarketStatsCard } from "@/components/trade/MarketStatsCard";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
      <div className="border-b border-[var(--border)]/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
        {title}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

function AnalyticsPageInner({ slab }: { slab: string }) {
  const { loading, error } = useSlabState();

  if (loading) {
    return (
      <div className="flex min-h-[calc(100dvh-48px)] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex min-h-[calc(100dvh-48px)] items-center justify-center px-4 text-center">
        <p className="text-[11px] text-[var(--text-secondary)]">{error}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-4 lg:px-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-sm font-semibold uppercase tracking-[0.15em] text-[var(--text)]">
          Market analytics
        </h1>
        <a
          href={`/trade/${slab}`}
          className="border border-[var(--border)] px-3 py-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/40 hover:text-[var(--text)]"
        >
          ← Back to trade
        </a>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <ErrorBoundary label="MarketStatsCard">
          <Section title="Market stats"><MarketStatsCard /></Section>
        </ErrorBoundary>
        <ErrorBoundary label="EngineHealthCard">
          <Section title="Engine health"><EngineHealthCard /></Section>
        </ErrorBoundary>
        <ErrorBoundary label="CrankHealthCard">
          <Section title="Crank health"><CrankHealthCard /></Section>
        </ErrorBoundary>
        <ErrorBoundary label="OpenInterestCard">
          <Section title="Open interest"><OpenInterestCard slabAddress={slab} /></Section>
        </ErrorBoundary>
        <ErrorBoundary label="InsuranceDashboard">
          <Section title="Insurance"><InsuranceDashboard slabAddress={slab} /></Section>
        </ErrorBoundary>
        <ErrorBoundary label="LiquidationAnalytics">
          <Section title="Liquidations"><LiquidationAnalytics /></Section>
        </ErrorBoundary>
        <ErrorBoundary label="SystemCapitalCard">
          <Section title="System capital"><SystemCapitalCard /></Section>
        </ErrorBoundary>
        <ErrorBoundary label="AdlLeaderboard">
          <Section title="ADL leaderboard"><AdlLeaderboard slabAddress={slab} /></Section>
        </ErrorBoundary>
        <ErrorBoundary label="AccountsCard">
          <Section title="All accounts & liqs"><AccountsCard /></Section>
        </ErrorBoundary>
      </div>
    </div>
  );
}

function isValidPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export default function AnalyticsPage({ params }: { params: Promise<{ slab: string }> }) {
  const { slab } = use(params);
  if (!isValidPublicKey(slab)) {
    return (
      <div className="flex min-h-[calc(100dvh-48px)] items-center justify-center">
        <p className="text-[11px] text-[var(--text-secondary)]">Invalid market address.</p>
      </div>
    );
  }
  return (
    <SlabProvider slabAddress={slab}>
      <UsdToggleProvider>
        <AnalyticsPageInner slab={slab} />
      </UsdToggleProvider>
    </SlabProvider>
  );
}
