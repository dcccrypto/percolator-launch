"use client";

import { FC, useCallback, useRef, useState } from "react";
import { FEE_SPLIT } from "@percolatorct/sdk";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { useStakePool } from "@/hooks/useStakePool";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { sanitizeOnChainValue } from "@/lib/health";
import { formatUsdFromNumber } from "@/lib/format";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { EngineHealthCard } from "@/components/trade/EngineHealthCard";
import { CrankHealthCard } from "@/components/trade/CrankHealthCard";
import { LiquidationAnalytics } from "@/components/trade/LiquidationAnalytics";

/**
 * Sticky bottom analytics dock (desktop ≥ lg).
 *
 * The old flow sent traders to a separate `/analytics/[slab]` route for every
 * engine/capital/fee read. This surfaces the same data inline: a thin footer
 * bar with four tabs — hovering (or clicking/focusing) one slides its panel up
 * over the terminal, so the numbers are one glance away without a navigation.
 *
 * Design rules baked in here:
 *  - No repetition of the top MarketInfoBar (mark price, 24h Δ, vol, OI total,
 *    high/low, spread, funding, live badge live up there) — the dock only shows
 *    what the bar does NOT: the capital stack, health internals, liquidation
 *    params, and the fee split.
 *  - No claimable-fee figure (that's the creator-only /analytics claim panel).
 *    The Fees tab shows the split policy + realized protocol/LP/insurance
 *    amounts; the creator leg is a share % only.
 *  - Fast: each tab's data hooks live in a subcomponent that only MOUNTS while
 *    that tab is open, so the closed dock costs nothing, and reused cards ride
 *    the SlabProvider already mounted by the trade page (no extra RPC).
 *  - No garbage: every on-chain figure goes through the same sanitizeOnChainValue
 *    guard (u64::MAX sentinels → filtered) the analytics cards already use, and
 *    the reused Engine/Crank/Liquidation cards keep their own sanitization.
 */

const TABS = [
  { key: "capital", label: "Capital" },
  { key: "health", label: "Health" },
  { key: "liquidations", label: "Liquidations" },
  { key: "fees", label: "Fees" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

/* ── Capital: the backstop stack (LP vault + insurance + stake) ─────────────
   None of these three appear in the top bar. All are collateral (sim-USDC)
   atoms — divided by the collateral decimals only, NEVER multiplied by the
   market's base-asset price (that mislabel is the exact bug MarketStatsCard
   documents for "Market LP"). */
const CapitalSection: FC<{ slab: string }> = ({ slab }) => {
  const { insuranceBalance, loading } = useEngineState();
  const { config } = useSlabState();
  const { market } = useMarketInfo(slab);
  const { state: stakeState } = useStakePool();
  const stakeExists = stakeState?.poolExists ?? false;
  const stakeVault = stakeState?.vaultBalance ?? 0n;
  const decimals = useTokenMeta(config?.collateralMint ?? null)?.decimals ?? 6;
  const div = 10 ** decimals;

  // LP vault: on-chain LP-portfolio capital, same source + null-guard as
  // MarketStatsCard's "Market LP" (vault_balance ?? c_tot from /api/markets).
  const lpUsd = (() => {
    const raw = market?.vault_balance ?? market?.c_tot;
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return Number(sanitizeOnChainValue(BigInt(Math.round(n)))) / div;
  })();
  const insUsd = insuranceBalance != null ? Number(sanitizeOnChainValue(insuranceBalance)) / div : null;
  // Stake pool: only real when the pool exists on-chain; empty/uninitialized
  // pools legitimately read $0, not "missing".
  const stakeUsd = stakeExists ? Number(sanitizeOnChainValue(stakeVault)) / div : 0;

  if (loading && lpUsd == null && insUsd == null) {
    return <p className="text-[10px] text-[var(--text-secondary)]">Loading capital…</p>;
  }

  const total = (lpUsd ?? 0) + (insUsd ?? 0) + stakeUsd;
  const pct = (v: number) => (total > 0 ? (v / total) * 100 : 0);
  const layers = [
    { key: "lp", label: "LP vault", role: "Counterparty capital", usd: lpUsd ?? 0, color: "var(--long)", muted: lpUsd == null },
    { key: "ins", label: "Insurance fund", role: "Reserve backstop", usd: insUsd ?? 0, color: "var(--accent-text)", muted: insUsd == null },
    { key: "stake", label: "Stake pool", role: stakeExists ? "Junior tranche" : "Not staked", usd: stakeUsd, color: "var(--text-muted)", muted: stakeUsd === 0 },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      {/* stack */}
      <div>
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
            {formatUsdFromNumber(total)}
          </span>
          <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">total backing</span>
        </div>
        <div className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
          {layers.filter((l) => l.usd > 0).map((l) => (
            <div key={l.key} style={{ width: `${pct(l.usd)}%`, background: l.color }} title={`${l.label} ${pct(l.usd).toFixed(1)}%`} />
          ))}
        </div>
        <div className="mt-3">
          {layers.map((l) => (
            <div key={l.key} className="flex items-center gap-2.5 border-b border-[var(--border)]/20 py-2 last:border-b-0">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: l.color }} />
              <div className="min-w-0">
                <div className="text-[12px] text-[var(--text)]">{l.label}</div>
                <div className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-muted)]">{l.role}</div>
              </div>
              <div className="ml-auto text-right">
                <div className={`text-[13px] font-bold ${l.muted ? "text-[var(--text-secondary)]" : "text-[var(--text)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                  {formatUsdFromNumber(l.usd)}
                </div>
                <div className="text-[9px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {l.usd === 0 ? (l.key === "stake" && !stakeExists ? "—" : "empty") : `${pct(l.usd).toFixed(1)}%`}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* explainer — no repeated OI/price stats, just what the stack means */}
      <div className="rounded-none border border-[var(--border)]/30 bg-[var(--bg-elevated)] p-3">
        <div className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--text-secondary)]">Loss-absorption order</div>
        <ol className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          <li><span className="text-[var(--text-muted)]">1 ·</span> <span className="text-[var(--text)]">Stake pool</span> — junior / first-loss</li>
          <li><span className="text-[var(--text-muted)]">2 ·</span> <span className="text-[var(--text)]">Insurance fund</span> — reserve backstop</li>
          <li><span className="text-[var(--text-muted)]">3 ·</span> <span className="text-[var(--text)]">LP vault</span> — counterparty capital</li>
        </ol>
      </div>
    </div>
  );
};

/* ── Fees: split policy + realized amounts, NO claimable figure ────────────── */
const FeesSection: FC = () => {
  const { wrapperConfigV17: cfg } = useSlabState();
  const decimals = useTokenMeta(cfg?.collateralMint ?? null)?.decimals ?? 6;

  if (!cfg) {
    return <p className="text-[11px] text-[var(--text-secondary)]">Fee split is a v17 feature — unavailable on this market.</p>;
  }
  const toUsd = (a: bigint) => Number(a) / 10 ** decimals;
  const baseFeeBps = Number(cfg.tradeFeeBps);
  const baseFeeStr = (baseFeeBps / 100).toFixed(baseFeeBps % 100 === 0 ? 0 : 2) + "%";
  const legs = [
    { key: "lp", label: "LP", bps: cfg.lpShareBps, usd: toUsd(cfg.lpFeeAccruedAtoms) as number | null, color: "var(--long)" },
    { key: "protocol", label: "Protocol", bps: FEE_SPLIT.PROTOCOL_FEE_BPS, usd: toUsd(cfg.protocolFeeAccruedAtoms) as number | null, color: "var(--text-dim)" },
    { key: "insurance", label: "Insurance", bps: cfg.insuranceShareBps, usd: toUsd(cfg.insuranceReserveAccruedAtoms) as number | null, color: "var(--short)" },
    // Creator leg: share % only. The claimable amount is intentionally omitted
    // here — it lives on the creator-only /analytics claim panel.
    { key: "creator", label: "Creator", bps: cfg.creatorShareBps, usd: null, color: "var(--accent-text)" },
  ];
  const pct = (bps: number) => `${((bps / 10_000) * 100).toFixed(Number.isInteger((bps / 10_000) * 100) ? 0 : 1)}%`;

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-secondary)]">trade fee · split 4 ways</span>
          <span className="text-[13px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{baseFeeStr}</span>
        </div>
        <div className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
          {legs.map((l) => (
            <div key={l.key} style={{ width: pct(l.bps), background: l.color }} title={`${l.label} ${pct(l.bps)}`} />
          ))}
        </div>
      </div>
      <div>
        {legs.map((l) => (
          <div key={l.key} className="flex items-center gap-2.5 border-b border-[var(--border)]/20 py-2 text-[12px] last:border-b-0">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: l.color }} />
            <span className="text-[var(--text-secondary)]">{l.label}</span>
            <span className="text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{pct(l.bps)}</span>
            <span className="ml-auto text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
              {l.usd == null ? (
                <span className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-muted)]">share only</span>
              ) : (
                <>
                  {formatUsdFromNumber(l.usd)}
                  <span className="ml-1.5 text-[8px] uppercase tracking-[0.1em] text-[var(--text-muted)]">collected</span>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ── Health / Liquidations reuse the audited analytics cards verbatim ──────── */
const HealthSection: FC = () => (
  <div className="grid gap-3 md:grid-cols-2">
    <ErrorBoundary label="EngineHealthCard"><EngineHealthCard /></ErrorBoundary>
    <ErrorBoundary label="CrankHealthCard"><CrankHealthCard /></ErrorBoundary>
  </div>
);
const LiquidationsSection: FC = () => (
  <ErrorBoundary label="LiquidationAnalytics"><LiquidationAnalytics /></ErrorBoundary>
);

export const AnalyticsDock: FC<{ slab: string }> = ({ slab }) => {
  const [active, setActive] = useState<TabKey | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const open = useCallback((k: TabKey) => { cancelClose(); setActive(k); }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setActive(null), 140);
  }, [cancelClose]);

  return (
    // Desktop-only: hover is the interaction, and at ≥ lg there's no competing
    // bottom bar (MobileBottomNav is md:hidden, MobileOrderSheet is lg:hidden).
    // Mobile keeps the utility-row "Analytics →" link.
    <div
      className="fixed inset-x-0 bottom-0 z-40 hidden border-t border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-sm lg:block"
      onMouseLeave={scheduleClose}
    >
      {/* expanding panel — slides up OVER the terminal, above the bar */}
      {active && (
        <div
          className="absolute inset-x-0 bottom-full max-h-[48vh] overflow-y-auto border-t border-[var(--border)] bg-[var(--bg)]/98 backdrop-blur-md shadow-[0_-16px_48px_rgba(0,0,0,0.55)]"
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <div className="mx-auto max-w-[1920px] px-4 py-3.5 lg:px-6">
            {active === "capital" && <CapitalSection slab={slab} />}
            {active === "health" && <HealthSection />}
            {active === "liquidations" && <LiquidationsSection />}
            {active === "fees" && <FeesSection />}
          </div>
        </div>
      )}

      {/* the thin sticky bar — pl clears the fixed MusicPlayer button (bottom-left) */}
      <div className="mx-auto flex max-w-[1920px] items-stretch pl-16 pr-2">
        <span className="hidden items-center gap-1.5 pr-3 text-[9px] font-medium uppercase tracking-[0.18em] text-[var(--text-dim)] xl:flex">
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
          </svg>
          Analytics
        </span>
        {TABS.map((t) => {
          const on = active === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onMouseEnter={() => open(t.key)}
              onFocus={() => open(t.key)}
              onClick={() => (on ? setActive(null) : setActive(t.key))}
              aria-expanded={on}
              className={[
                "relative px-3.5 py-2 text-[10px] font-medium uppercase tracking-[0.14em] transition-colors duration-150",
                on ? "text-[var(--text)]" : "text-[var(--text-secondary)] hover:text-[var(--text)]",
              ].join(" ")}
            >
              {t.label}
              <span
                className={[
                  "absolute inset-x-2 -top-px h-px transition-opacity duration-150",
                  on ? "bg-[var(--accent)] opacity-100" : "opacity-0",
                ].join(" ")}
              />
            </button>
          );
        })}
        <a
          href={`/analytics/${slab}`}
          className="ml-auto flex items-center pr-2 text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--accent)]"
        >
          Full page →
        </a>
      </div>
    </div>
  );
};
