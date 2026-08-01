"use client";

import { FC, useCallback, useEffect, useRef, useState } from "react";
import { FEE_SPLIT } from "@percolatorct/sdk";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { useStakePool } from "@/hooks/useStakePool";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { sanitizeOnChainValue } from "@/lib/health";
import { formatUsdFromNumber } from "@/lib/format";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { EngineHealthCard } from "@/components/trade/EngineHealthCard";
import { CrankHealthCard } from "@/components/trade/CrankHealthCard";

/**
 * Sticky bottom analytics dock (desktop ≥ lg).
 *
 * A thin footer bar with four tabs — hovering (or clicking/focusing) one opens
 * a compact, LEFT-ANCHORED popover sized to its own content (not a full-width
 * strip), so the same data the `/analytics/[slab]` route shows is one glance
 * away without a navigation.
 *
 * Design rules baked in:
 *  - Panels hug their content on the left — no full-bleed, no dead space.
 *  - No repetition of the top MarketInfoBar (mark price, 24h Δ, vol, OI total,
 *    high/low, spread, funding, live badge). The dock shows only what the bar
 *    does NOT: the capital stack, health internals, liquidation/risk params,
 *    and the fee split.
 *  - No claimable-fee figure (that's the creator-only /analytics claim panel).
 *  - Fast: each tab's data hooks live in a subcomponent that only MOUNTS while
 *    that tab is open; the closed dock costs nothing and reused cards ride the
 *    SlabProvider the trade page already mounted (no extra RPC).
 *  - No garbage: every on-chain figure goes through sanitizeOnChainValue (the
 *    u64::MAX sentinel guard the analytics cards use); Engine/Crank cards keep
 *    their own sanitization.
 */

const TABS = [
  { key: "capital", label: "Capital" },
  { key: "health", label: "Health" },
  { key: "liquidations", label: "Liquidations" },
  { key: "fees", label: "Fees" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const SECTION_LABEL = "text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]";

/* ── Capital: the backstop stack (LP vault + insurance + stake) ─────────────
   None of these three are in the top bar. All are collateral (sim-USDC) atoms
   — divided by collateral decimals only, NEVER ×base-asset price. */
const CapitalSection: FC<{ slab: string }> = ({ slab }) => {
  const { insuranceBalance, loading } = useEngineState();
  const { config } = useSlabState();
  const { market } = useMarketInfo(slab);
  const { state: stakeState } = useStakePool();
  const stakeExists = stakeState?.poolExists ?? false;
  const stakeVault = stakeState?.vaultBalance ?? 0n;
  const decimals = useTokenMeta(config?.collateralMint ?? null)?.decimals ?? 6;
  const div = 10 ** decimals;

  const lpUsd = (() => {
    const raw = market?.vault_balance ?? market?.c_tot;
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return Number(sanitizeOnChainValue(BigInt(Math.round(n)))) / div;
  })();
  const insUsd = insuranceBalance != null ? Number(sanitizeOnChainValue(insuranceBalance)) / div : null;
  const stakeUsd = stakeExists ? Number(sanitizeOnChainValue(stakeVault)) / div : 0;

  if (loading && lpUsd == null && insUsd == null) {
    return <p className="w-[320px] text-[10px] text-[var(--text-secondary)]">Loading capital…</p>;
  }

  // "Total backing" = the capital that actually backs positions: the LP vault
  // (counterparty) + the insurance fund (bad-debt backstop). The stake pool is
  // NOT in the automatic loss path — verified against the v17 engine + wrapper
  // + stake program: the engine has no stake concept, and mode-0 stakers only
  // pre-fund insurance via a manual admin FlushToInsurance (the junior tranche
  // is off by default). So stake is shown separately, not summed into backing.
  const backing = (lpUsd ?? 0) + (insUsd ?? 0);
  const pct = (v: number) => (backing > 0 ? (v / backing) * 100 : 0);
  const layers = [
    { key: "lp", label: "LP vault", role: "Counterparty capital", usd: lpUsd ?? 0, color: "var(--long)", muted: lpUsd == null },
    { key: "ins", label: "Insurance fund", role: "Bad-debt backstop", usd: insUsd ?? 0, color: "var(--accent-text)", muted: insUsd == null },
  ];

  return (
    <div className="w-[268px]">
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
          {formatUsdFromNumber(backing)}
        </span>
        <span className={SECTION_LABEL}>total backing</span>
      </div>
      <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
        {layers.filter((l) => l.usd > 0).map((l) => (
          <div key={l.key} style={{ width: `${pct(l.usd)}%`, background: l.color }} title={`${l.label} ${pct(l.usd).toFixed(1)}%`} />
        ))}
      </div>
      <div className="mt-1.5">
        {layers.map((l) => (
          <div key={l.key} className="flex items-center gap-2 border-b border-[var(--border)]/20 py-1 last:border-b-0">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: l.color }} />
            <div className="min-w-0">
              <div className="text-[11px] text-[var(--text)]">{l.label}</div>
              <div className="text-[8px] uppercase tracking-[0.08em] text-[var(--text-muted)]">{l.role}</div>
            </div>
            <div className="ml-auto text-right">
              <div className={`text-[12px] font-bold ${l.muted ? "text-[var(--text-secondary)]" : "text-[var(--text)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                {formatUsdFromNumber(l.usd)}
              </div>
              <div className="text-[8px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                {l.usd === 0 ? "empty" : `${pct(l.usd).toFixed(1)}%`}
              </div>
            </div>
          </div>
        ))}
      </div>
      {/* Stake pool — deliberately NOT in "total backing": not an automatic
          loss tier; mode-0 stakers only pre-fund insurance via a manual flush. */}
      <div className="mt-1.5 flex items-center gap-2 border-t border-[var(--border)]/40 pt-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--text-muted)]" />
        <div className="min-w-0">
          <div className="text-[11px] text-[var(--text-secondary)]">Stake pool</div>
          <div className="text-[8px] uppercase tracking-[0.08em] text-[var(--text-muted)]">{stakeExists ? "Pre-funds insurance" : "Not staked"}</div>
        </div>
        <div className="ml-auto text-[12px] font-bold text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
          {stakeExists ? formatUsdFromNumber(stakeUsd) : "—"}
        </div>
      </div>
      <p className="mt-1.5 text-[8px] leading-relaxed text-[var(--text-muted)]">
        Losses fall on the position margin first, then the insurance fund, then LP and winning positions. Staked funds help only if an admin flushes them into insurance.
      </p>
    </div>
  );
};

/* ── Fees: split policy + realized amounts, NO claimable figure ────────────── */
const FeesSection: FC = () => {
  const { wrapperConfigV17: cfg } = useSlabState();
  const decimals = useTokenMeta(cfg?.collateralMint ?? null)?.decimals ?? 6;

  if (!cfg) {
    return <p className="w-[320px] text-[11px] text-[var(--text-secondary)]">Fee split is a v17 feature — unavailable on this market.</p>;
  }
  const toUsd = (a: bigint) => Number(a) / 10 ** decimals;
  const baseFeeBps = Number(cfg.tradeFeeBps);
  const baseFeeStr = (baseFeeBps / 100).toFixed(baseFeeBps % 100 === 0 ? 0 : 2) + "%";
  const legs = [
    { key: "lp", label: "LP", bps: cfg.lpShareBps, usd: toUsd(cfg.lpFeeAccruedAtoms) as number | null, color: "var(--long)" },
    { key: "protocol", label: "Protocol", bps: FEE_SPLIT.PROTOCOL_FEE_BPS, usd: toUsd(cfg.protocolFeeAccruedAtoms) as number | null, color: "var(--text-dim)" },
    { key: "insurance", label: "Insurance", bps: cfg.insuranceShareBps, usd: toUsd(cfg.insuranceReserveAccruedAtoms) as number | null, color: "var(--short)" },
    // Creator leg: share % only. Claimable amount intentionally omitted here.
    { key: "creator", label: "Creator", bps: cfg.creatorShareBps, usd: null, color: "var(--accent-text)" },
  ];
  const pct = (bps: number) => `${((bps / 10_000) * 100).toFixed(Number.isInteger((bps / 10_000) * 100) ? 0 : 1)}%`;

  return (
    <div className="w-[268px]">
      <div className="flex items-baseline justify-between">
        <span className={SECTION_LABEL}>trade fee · split 4 ways</span>
        <span className="text-[12px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{baseFeeStr}</span>
      </div>
      <div className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-elevated)]">
        {legs.map((l) => (
          <div key={l.key} style={{ width: pct(l.bps), background: l.color }} title={`${l.label} ${pct(l.bps)}`} />
        ))}
      </div>
      <div className="mt-1.5">
        {legs.map((l) => (
          <div key={l.key} className="flex items-center gap-2 border-b border-[var(--border)]/20 py-1 text-[11px] last:border-b-0">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: l.color }} />
            <span className="text-[var(--text-secondary)]">{l.label}</span>
            <span className="text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{pct(l.bps)}</span>
            <span className="ml-auto text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
              {l.usd == null ? (
                <span className="text-[8px] uppercase tracking-[0.1em] text-[var(--text-muted)]">share only</span>
              ) : (
                <>
                  {formatUsdFromNumber(l.usd)}
                  <span className="ml-1 text-[8px] uppercase tracking-[0.1em] text-[var(--text-muted)]">collected</span>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

/* ── Liquidations / risk: params + insurance coverage. Richer than the old
   /analytics card (which showed only liq-fee + buffer + coverage on v17). ── */
const LiquidationsSection: FC = () => {
  const { params, insuranceBalance, totalOI, isV17, loading, hasData } = useEngineState();
  const { config } = useSlabState();
  const decimals = useTokenMeta(config?.collateralMint ?? null)?.decimals ?? 6;
  const div = 10 ** decimals;
  const { priceUsd } = useLivePrice();

  if (loading) return <p className="w-[320px] text-[10px] text-[var(--text-secondary)]">Loading…</p>;
  if (!hasData) return <p className="w-[320px] text-[10px] text-[var(--text-secondary)]">No liquidation data for this market.</p>;

  const bps = (v: bigint | number | null | undefined) => (v == null ? null : Number(v));
  const pctStr = (b: number | null) => (b == null ? "—" : `${(b / 100).toFixed(2)}%`);
  const liqFee = params ? bps(params.liquidationFeeBps) : null;
  const buffer = params ? bps(params.liquidationBufferBps) : null;
  const maint = params ? bps(params.maintenanceMarginBps) : null;
  const initMargin = params ? bps(params.initialMarginBps) : null;
  const maxLev = initMargin && initMargin > 0 ? `${(10_000 / initMargin).toFixed(1)}×` : "—";

  // Insurance coverage = insurance (collateral USD) / OI (USD). v17 OI is a
  // base-asset Q qty → ×price; v12 OI is already collateral-notional.
  const insUsd = insuranceBalance != null ? Number(sanitizeOnChainValue(insuranceBalance)) / div : null;
  const oiRaw = totalOI != null ? Number(sanitizeOnChainValue(totalOI)) : null;
  const oiUsd = oiRaw == null ? null : isV17 ? (priceUsd != null ? (oiRaw / 1_000_000) * priceUsd : null) : oiRaw / div;
  const coverage = insUsd == null || oiUsd == null ? null : oiUsd > 0 ? (insUsd / oiUsd) * 100 : Infinity;
  const covColor = coverage == null ? "text-[var(--text-secondary)]" : coverage === Infinity || coverage > 100 ? "text-[var(--long)]" : coverage >= 10 ? "text-[var(--warning)]" : "text-[var(--short)]";
  const covDot = coverage == null ? "bg-[var(--text-dim)]" : coverage === Infinity || coverage > 100 ? "bg-[var(--long)]" : coverage >= 10 ? "bg-[var(--warning)]" : "bg-[var(--short)]";
  const covText = coverage == null ? "—" : coverage === Infinity ? "∞" : `${coverage.toFixed(1)}%`;
  const fmt = (n: number | null) => (n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(2)}K` : `$${n.toFixed(2)}`);

  const cells = [
    { k: "Liq. fee", v: pctStr(liqFee) },
    { k: "Buffer", v: pctStr(buffer) },
    { k: "Maint. margin", v: pctStr(maint) },
    { k: "Init. margin", v: pctStr(initMargin) },
    { k: "Max leverage", v: maxLev },
    { k: "Insurance", v: fmt(insUsd) },
  ];

  return (
    <div className="w-[320px]">
      <div className="grid grid-cols-3 gap-px overflow-hidden border border-[var(--border)]/30">
        {cells.map((c) => (
          <div key={c.k} className="bg-[var(--bg)]/40 px-2 py-1">
            <div className="text-[7.5px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">{c.k}</div>
            <div className="mt-0.5 text-[12px] font-bold text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{c.v}</div>
          </div>
        ))}
      </div>
      {/* Insurance coverage — the key liquidation-safety signal */}
      <div className="mt-1.5 flex items-center justify-between border border-[var(--border)]/30 bg-[var(--bg-elevated)] px-2 py-1.5">
        <span className={SECTION_LABEL}>insurance coverage</span>
        <div className="flex items-center gap-2.5">
          <span className="text-[8px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>OI {fmt(oiUsd)}</span>
          <span className="flex items-center gap-1.5">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${covDot}`} />
            <span className={`text-[12px] font-bold ${covColor}`} style={{ fontFamily: "var(--font-mono)" }}>{covText}</span>
          </span>
        </div>
      </div>
      <p className="mt-1.5 text-[8px] leading-relaxed text-[var(--text-muted)]">
        Positions liquidate below maintenance margin; the buffer prevents re-liquidation.
      </p>
    </div>
  );
};

/* ── Health reuses the audited analytics cards, stacked in one narrow column
   (keeps their sanitization; narrow width matches the other panels) ───────── */
const HealthSection: FC = () => (
  <div className="flex w-[300px] flex-col gap-1.5">
    <ErrorBoundary label="EngineHealthCard"><EngineHealthCard /></ErrorBoundary>
    <ErrorBoundary label="CrankHealthCard"><CrankHealthCard /></ErrorBoundary>
  </div>
);

const PANEL_TITLES: Record<TabKey, string> = {
  capital: "Capital stack",
  health: "Market health",
  liquidations: "Liquidation & risk",
  fees: "Fee distribution",
};

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

  // This dock is `position: fixed` at the bottom of the viewport, so when the
  // page is scrolled to the end it sits directly on top of the site footer —
  // covering the footer's links AND making its own tabs collide with them
  // (both go "dead"). Watch the footer with an IntersectionObserver and, while
  // any of it is on screen, slide + fade the dock out of the way (with
  // pointer-events off so clicks reach the footer); restore it the moment the
  // footer scrolls back off screen. Both transitions ride the CSS transition
  // on the dock below, so it's smooth in and out.
  const [footerVisible, setFooterVisible] = useState(false);
  useEffect(() => {
    const footer = document.querySelector("footer");
    if (!footer) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        setFooterVisible(entry.isIntersecting);
        // Don't leave a hover panel floating in mid-air as the dock slides out.
        if (entry.isIntersecting) setActive(null);
      },
      { threshold: 0 },
    );
    io.observe(footer);
    return () => io.disconnect();
  }, []);

  return (
    // Desktop-only status bar (self-hides < lg, where the mobile bars live).
    // A thin baseline that reads as the terminal's status bar; the interactive
    // part is a left-aligned segmented control matching the site's own toggles.
    <div
      aria-hidden={footerVisible || undefined}
      className={`fixed inset-x-0 bottom-0 z-40 hidden h-9 border-t border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-sm transition-[opacity,transform] duration-200 ease-out lg:block ${
        footerVisible ? "pointer-events-none translate-y-full opacity-0" : "translate-y-0 opacity-100"
      }`}
    >
      {/* pl clears the fixed MusicPlayer button in the bottom-left corner */}
      <div className="mx-auto flex h-full max-w-[1920px] items-center pl-16 pr-4">
        {/* left: link out to the full analytics page */}
        <a
          href={`/analytics/${slab}`}
          className="flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-[0.16em] text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--accent-text)]"
        >
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
          </svg>
          Full analytics
          <span aria-hidden="true" className="text-[var(--text-dim)]">↗</span>
        </a>

        {/* right: plain inline tabs (no well) + panel anchored above them */}
        <div className="relative ml-auto flex h-full items-stretch" onMouseLeave={scheduleClose}>
          {active && (
            <div
              className="absolute bottom-full right-0 mb-1.5 w-max max-w-[min(94vw,520px)] max-h-[70vh] overflow-y-auto border border-[var(--border)] bg-[var(--bg)]/98 backdrop-blur-md shadow-[0_-12px_40px_rgba(0,0,0,0.5)]"
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              {/* header — same idiom as the /analytics Section wrapper */}
              <div className="flex items-center justify-between border-b border-[var(--border)]/50 px-3 py-1.5">
                <span className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--text-secondary)]">{PANEL_TITLES[active]}</span>
                <a href={`/analytics/${slab}`} className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-muted)] transition-colors hover:text-[var(--accent-text)]">full →</a>
              </div>
              <div className="px-3 py-2.5">
                {active === "capital" && <CapitalSection slab={slab} />}
                {active === "health" && <HealthSection />}
                {active === "liquidations" && <LiquidationsSection />}
                {active === "fees" && <FeesSection />}
              </div>
            </div>
          )}
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
                  "relative flex items-center px-3 text-[10px] font-medium uppercase tracking-[0.12em] transition-colors duration-150",
                  on ? "text-[var(--accent-text)]" : "text-[var(--text-secondary)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                {t.label}
                {/* active indicator: a hairline at the top edge, pointing up to the panel */}
                <span
                  className={[
                    "absolute inset-x-2 top-0 h-px bg-[var(--accent)] transition-opacity duration-150",
                    on ? "opacity-100" : "opacity-0",
                  ].join(" ")}
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
