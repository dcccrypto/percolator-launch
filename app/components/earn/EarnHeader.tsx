'use client';

import { useState } from 'react';
import type { EarnStats } from '@/hooks/useEarnStats';
import { ShimmerSkeleton } from '@/components/ui/ShimmerSkeleton';
import { FeeBreakdown } from "@/components/FeeBreakdown";
import { FEE_LEGS, legPercent } from "@/lib/fee-breakdown";
import { isDevnetV22Enabled } from "@/lib/v22/flag";
import { V22_COPY } from "@/lib/v22/copy";
import { GradientText } from "@/components/ui/GradientText";

/**
 * The figures as plain text, formatted as AnimatedNumber's final frame. Not animated: a count-up
 * from $0 (and again on every 15 s poll) meant a glance or a screenshot could catch any value on
 * the way, reported on Discord as TVL "anywhere from $198K to $415K".
 */
const usd = (v: number): string => `$${Math.round(v).toLocaleString()}`;
const FIGURE = "font-[var(--font-jetbrains-mono)] tabular-nums text-2xl font-bold text-[var(--text)]";

/** Derived, never restated — see lib/fee-breakdown.ts. */
const LP_SHARE_PCT = legPercent(FEE_LEGS.find((l) => l.id === "lp")!);


interface EarnHeaderProps {
  stats: EarnStats;
  loading: boolean;
}

export function EarnHeader({ stats, loading }: EarnHeaderProps) {
  // The full fee split is reference material: one sentence says what Earn pays, and the split
  // opens on request (UX: the page leads with what it does, the detail is a click away).
  const [splitOpen, setSplitOpen] = useState(false);
  return (
    <div className="relative">
      {/* Background grid fade */}
      <div className="absolute inset-x-0 top-0 h-48 bg-grid pointer-events-none" />

      {/* Same width and gutters as the vault table below, so the header spans the page with it. */}
      <div className="relative mx-auto max-w-[1400px] px-4 pt-10 pb-6 lg:px-6">
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,40rem)] xl:items-end xl:gap-10">
          <div className="min-w-0">
            {/* Section tag */}
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.25em] text-[var(--accent)]/60">
              // earn
            </div>

            {/* Title */}
            <h1
              className="text-2xl font-medium tracking-[-0.01em] text-[var(--text)]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Earn from{" "}
              <GradientText variant="headline">trading fees</GradientText>
            </h1>
            {/* Corrected 2026-07-28: fees ARE paid into the vault on the deployed program (a
                500-notional round trip accrued the vault's 48% and moved it in on its own). */}
            <p className="mt-2 max-w-[68ch] text-[14px] xl:max-w-none leading-relaxed text-[var(--text-secondary)]">
              {/* v2.2 vaults can hold other collateral: each vault's own token is named in its deposit rail. */}
              {isDevnetV22Enabled() ? V22_COPY.earnPage.depositLead : "Deposit USDC into a market's vault."} {LP_SHARE_PCT}% of every trading fee on that market is
              added to the vault, so your deposit grows as people trade it.{" "}
              {/* Always visible: the detailed Risk notice row below starts closed, so the downside is stated here too. */}
              <span data-testid="earn-loss-line">It can also fall when traders win, so only deposit what you can afford to lose.</span>
            </p>
            <button
              type="button"
              data-testid="earn-fee-split-toggle"
              aria-expanded={splitOpen}
              aria-controls="earn-fee-split"
              onClick={() => setSplitOpen((o) => !o)}
              className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 text-[12px] text-[var(--accent-text)] underline decoration-dotted underline-offset-4 hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] sm:min-h-0 sm:py-1"
            >
              Where does the rest of each fee go?
              <span aria-hidden="true" className={`transition-transform duration-150 ${splitOpen ? "rotate-180" : ""}`}>▾</span>
            </button>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-1 gap-px border border-[var(--border)] bg-[var(--border)] sm:grid-cols-3" aria-label="Earn statistics">
            <StatCell
              label="Total Value Locked"
              loading={loading}
            >
              <span className={FIGURE}>{usd(stats.tvl)}</span>
              {stats.unvaluedSymbols.length > 0 && (
                <p data-testid="earn-tvl-excludes" className="mt-1 text-[11px] text-[var(--text-muted)]">
                  {excludesNote(stats.unvaluedSymbols)}
                </p>
              )}
            </StatCell>
            <StatCell
              label="Daily Fee Revenue"
              loading={loading}
            >
              <span className={FIGURE}>{usd(stats.dailyFeeRevenue)}</span>
            </StatCell>
            <StatCell
              label="Insurance Fund"
              loading={loading}
            >
              {/* Unknown for every market (no stats rows): a dash, not $0. */}
              <span className={FIGURE}>{stats.totalInsurance == null ? "—" : usd(stats.totalInsurance)}</span>
            </StatCell>
          </div>
        </div>

        <div id="earn-fee-split" data-testid="earn-fee-split" hidden={!splitOpen} className="mt-4 max-w-3xl border border-[var(--border)] bg-[var(--panel-bg)] p-3">
          <p className="mb-2 text-[11px] text-[var(--text-secondary)]">
            Every trade pays a fee, and every market splits it the same way. The vault&apos;s share is
            added automatically, so the yield follows real trading and reads 0% while a market is quiet.
          </p>
          <FeeBreakdown highlight="lp" />
        </div>
      </div>
    </div>
  );
}

/** "Excludes 1 vault (X) that can't be valued right now." Names up to three, then counts the rest. */
export function excludesNote(symbols: string[]): string {
  const n = symbols.length;
  const shown = n > 3 ? `${symbols.slice(0, 3).join(", ")} and ${n - 3} more` : symbols.join(", ");
  return `Excludes ${n} vault${n === 1 ? "" : "s"} (${shown}) that can't be valued right now.`;
}

function StatCell({
  label,
  children,
  loading,
  tooltip,
}: {
  label: string;
  children: React.ReactNode;
  loading: boolean;
  tooltip?: string;
}) {
  return (
    <div className="bg-[var(--panel-bg)] p-4 sm:p-5">
      <div
        className={`text-[10px] uppercase tracking-[0.2em] text-[var(--text-secondary)] mb-1 ${
          tooltip ? 'cursor-help underline decoration-dotted decoration-[var(--text-muted)]' : ''
        }`}
        title={tooltip}
      >
        {label}
      </div>
      {loading ? (
        <ShimmerSkeleton className="h-7 w-24 rounded" />
      ) : (
        children
      )}
    </div>
  );
}
