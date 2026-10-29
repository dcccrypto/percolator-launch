"use client";

/**
 * UX WP-5 (audit §4.4): "How your deposit is protected" (was "Vault tranches"). Values follow the
 * program's own share-value path (tags 75/77): the vault LP at its certified equity, or — when
 * its certificate is stale — the value a simulated crank would certify (hooks/useVaultLpValuation),
 * never "Needs refresh". Plain words only (§5.1): creator stake, Earn deposits, share value.
 * Pure renderer: the rail/page pass the one `useMarketLimits` instance they also gate deposits with.
 */
import { useState, type FC } from "react";
import type { MarketLimits } from "@/hooks/useMarketLimits";
import { COPY } from "@/lib/limits/copy";
import { earnAbsorbed, seniorAtomsForRedemption, seniorSharePriceE6, type EarnTrancheView } from "@/lib/limits/vault-tranche";
import type { EarnWithdrawPricing } from "@/lib/limits/earn-display";

export interface EarnTrancheCardViewProps {
  limits: MarketLimits;
  view: EarnTrancheView | null;
  slab: string;
  /** The wallet's Earn shares (the card shows their value). */
  withdrawShares: bigint;
  decimals: number;
  collateralSymbol: string;
  /** Kept for callers; the APY row waits for fee history (WP-5: "APY later"). */
  nowSecs?: number;
  /** The simulated valuation's state (§3.7): running / last known as of. */
  valuation?: { updating: boolean; asOf: number | null } | null;
  /** What the vault can pay out now (88 path); the footnote shows only when it binds. */
  maxNowAtoms?: bigint | null;
  /**
   * App bug 2026-10-29: the withdraw pricing (earnPanelPricing). When given, Share value and "Your
   * Earn balance" are priced exactly as a withdrawal (the worse-of senior value during a price
   * catch-up), so they match the page's Value and the withdraw preview.
   */
  pricing?: EarnWithdrawPricing | null;
}

/** "$1,234.56" (2 dp, floored) for collateral atoms. */
function usd(a: bigint, decimals: number): string {
  const neg = a < 0n;
  const x = neg ? -a : a;
  const cents = (x * 100n) / 10n ** BigInt(decimals);
  return `${neg ? "−" : ""}$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
function pct(num: bigint, den: bigint): string {
  if (den <= 0n) return "0%";
  const bps = Number((num * 10_000n) / den);
  return `${(bps / 100).toFixed(2)}%`;
}

function Row({ label, value, sub, testId, data }: { label: string; value: React.ReactNode; sub?: React.ReactNode; testId?: string; data?: Record<string, string> }) {
  const dataAttrs = Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [`data-${k}`, v]));
  return (
    <div className="flex items-baseline justify-between gap-3 py-1" data-testid={testId} {...dataAttrs}>
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">{label}</span>
      <span className="text-right">
        <span className="font-mono text-[12px] tabular-nums text-[var(--text)]">{value}</span>
        {sub && <span className="ml-1.5 text-[11px] text-[var(--text-secondary)]">{sub}</span>}
      </span>
    </div>
  );
}

export const EarnTrancheCardView: FC<EarnTrancheCardViewProps> = ({ limits, view, withdrawShares, decimals, valuation = null, maxNowAtoms = null, pricing = null }) => {
  const [open, setOpen] = useState(false);
  const vs = limits.vaultState;
  if (!limits.flags.p3 || limits.state === "off") return null;
  if (limits.state === "loading") {
    return <div data-testid="limits-tranche-card" data-state="loading" className="mb-3 h-24 animate-pulse border border-[var(--border)] bg-[var(--bg-elevated)]" />;
  }
  if (!vs || !view) return null; // the vault does not own this market's liquidity
  const resolved = limits.engine?.mode === 1;
  // Never "Needs refresh": a stale certificate is valued by simulation (or shows the last value).
  const status = view.impaired === true ? "impaired" : view.senior === null ? "updating" : "covered";
  const absorbed = earnAbsorbed(vs);
  const totalShares = pricing?.totalShares ?? limits.registryShares ?? 0n;
  // The withdraw price when known, else the tranche split (same thing outside a price catch-up).
  const priceSenior = pricing ? pricing.withdrawSeniorValue : view.senior;
  const sharePriceE6 = pricing ? (priceSenior === null ? null : seniorSharePriceE6(priceSenior, totalShares)) : view.sharePriceE6;
  const yours = priceSenior !== null && withdrawShares > 0n && totalShares > 0n ? seniorAtomsForRedemption(withdrawShares, totalShares, priceSenior) : null;
  const money = (a: bigint | null) => (a === null ? "—" : usd(a, decimals));
  const showMaxNow = maxNowAtoms !== null && yours !== null && yours > maxNowAtoms;
  const updatingDot = (valuation?.updating || view.senior === null) && (
    <span aria-label="updating" data-testid="earn-value-updating" className="mr-1 inline-block h-[6px] w-[6px] animate-pulse rounded-full bg-[var(--text-muted)] align-middle" />
  );

  return (
    <div
      data-testid="limits-tranche-card"
      data-status={status}
      data-valuation={view.valuation}
      data-state={limits.state}
      className="mb-3 border border-[var(--border)] bg-[var(--panel-bg)] p-3"
    >
      <div className="mb-1 flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">How your deposit is protected</p>
        {status === "impaired" && (
          <span data-testid="earn-status-chip" className="border border-[var(--warning)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--warning)]">
            Covering a loss
          </span>
        )}
      </div>
      <div className="divide-y divide-[var(--border)]/30">
        <Row
          testId="limits-share-price"
          data={{ "price-e6": sharePriceE6?.toString() ?? "" }}
          label="Share value"
          value={
            <>
              {updatingDot}
              {sharePriceE6 === null ? "—" : `${(Number(sharePriceE6) / 1e6).toFixed(4)} USDC`}
            </>
          }
          sub={valuation?.asOf ? `as of ${new Date(valuation.asOf).toTimeString().slice(0, 5)}` : undefined}
        />
        {yours !== null && (
          <Row testId="earn-your-balance" label="Your Earn balance" value={money(yours)} sub={`(${pct(withdrawShares, totalShares)} of vault)`} />
        )}
        <Row testId="limits-junior-value" data={{ valuation: view.valuation }} label="Creator stake" value={money(view.junior)} sub="covers the first losses" />
        <Row testId="earn-deposits-value" label="Earn deposits" value={money(view.senior)} />
        <Row
          testId="limits-earn-absorbed"
          data={{ outstanding: (absorbed?.outstanding ?? 0n).toString(), drawn: (absorbed?.drawn ?? 0n).toString() }}
          label="Losses shared by Earn"
          value={absorbed && absorbed.outstanding > 0n ? `−${usd(absorbed.outstanding, decimals)}` : "$0.00"}
          sub={
            absorbed && absorbed.outstanding > 0n
              ? `(−${pct(absorbed.outstanding, (view.senior ?? 0n) + absorbed.outstanding)}) · ${usd(absorbed.restored, decimals)} restored`
              : undefined
          }
        />
        <Row
          testId="earn-fees-paid"
          data={{ atoms: vs.seniorFeeCreditedAtoms.toString() }}
          label="Fees paid to Earn"
          value={usd(vs.seniorFeeCreditedAtoms, decimals)}
          sub="so far"
        />
      </div>
      {view.impaired === true && (
        <p data-testid="limits-withdraw-effect" data-kind="impaired" className="pt-2 text-[12px] leading-snug text-[var(--text)]">
          {COPY.withdrawImpaired(money(view.senior))}
        </p>
      )}
      {showMaxNow && (
        <p data-testid="limits-withdraw-effect" data-kind="max-now" className="pt-2 text-[12px] leading-snug text-[var(--text-secondary)]">
          {COPY.withdrawIlliquid(money(maxNowAtoms))}
        </p>
      )}
      {resolved && (
        <p data-testid="earn-resolved" className="pt-2 text-[12px] leading-snug text-[var(--text-secondary)]">
          {COPY.resolvedSettled}
        </p>
      )}
      <div className="pt-2" data-testid="limits-risk-disclosure">
        <button
          type="button"
          data-testid="earn-how-losses-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)]"
        >
          How losses work {open ? "▴" : "▾"}
        </button>
        {open && (
          <div className="mt-1 space-y-1.5">
            <p className="text-[12px] leading-snug text-[var(--text)]">{COPY.howLossesWork}</p>
            <p className="text-[11px] leading-snug text-[var(--text-secondary)]">{COPY.howLossesFinePrint}</p>
          </div>
        )}
      </div>
    </div>
  );
};
