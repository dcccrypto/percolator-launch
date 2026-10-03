"use client";

import Link from "next/link";
import { useCallback, useSyncExternalStore } from "react";
import { getSnapshot, subscribeSlab } from "@/lib/priceStore/priceStore";
import { SlabProvider } from "@/components/providers/SlabProvider";
import { CloseFlow } from "@/components/trade/OtherMarketPositions";
import {
  getLiquidationSeverity,
  liveLiquidationDistancePct,
  LIQ_WARNING_PCT,
  type LiquidationSeverity,
  type PortfolioPosition,
} from "@/hooks/usePortfolio";
import { formatMarkPrice } from "@/lib/format";
import { describeLiqPrice } from "@/lib/liq-price-display";
import { describeEntryPrice } from "@/lib/entry-price-display";
import { LiqPriceValue } from "@/components/trade/LiqPriceValue";

export interface LiquidationRisk {
  pos: PortfolioPosition;
  /** Distance to liquidation at the live mark (liveLiquidationDistancePct). */
  distancePct: number;
  severity: Exclude<LiquidationSeverity, "safe">;
  /** The mark the distance was measured at (live, else the poll's oracle price). */
  markE6: bigint;
  /** Collateral decimals, for the close modal. */
  decimals: number;
}

/**
 * Identity of a position for UI state (keys, Hide). PortfolioPosition has no account id and
 * `idx` is always 0, so two positions on one market are told apart by NFT wrap, size and,
 * when it is a real cached entry, the entry price. Other entry sources follow the polled
 * mark (see resolveEntryPrice), so keying on them would change the key every poll. A partial
 * close changes the size, which re-arms a hidden warning; that is intended.
 */
export function riskKey(pos: PortfolioPosition): string {
  const entry = pos.entryPriceSource === "cache" ? `:${pos.effectiveEntryPrice}` : "";
  return `${pos.slabAddress}:${pos.nftWrapped ? "w" : "o"}:${pos.account?.positionSize ?? 0n}${entry}`;
}

export function riskLabel(pos: PortfolioPosition): string {
  return (pos.symbol ?? `${pos.slabAddress.slice(0, 6)}…`).replace(/-PERP$/i, "");
}

/**
 * One position near liquidation: market, side, live distance, a gauge that empties as the
 * price closes in, mark vs liquidation price, and the two things to do about it. Shared by
 * the /portfolio strip and the site-wide alert so both read and act the same way.
 */
export function LiquidationRiskItem({
  risk,
  onClose,
  onDismiss,
}: {
  risk: LiquidationRisk;
  /** Opens the close modal. The parent owns it, so it survives this row leaving the list. */
  onClose?: () => void;
  /** Shown as a small "Hide" control when set (the site-wide alert). */
  onDismiss?: () => void;
}) {
  const { pos, distancePct, severity, markE6, decimals } = risk;
  // The shared liquidation-price display, as on the position card (margin-health-surfaces guard).
  const liqDisplay = describeLiqPrice({
    liqPriceE6: pos.liquidationPriceE6,
    positionSize: pos.account?.positionSize ?? 0n,
    capital: pos.account?.capital ?? 0n,
    markPriceE6: markE6,
    maintenanceMarginBps: pos.maintenanceMarginBps,
    hasResolvedEntry: describeEntryPrice({ entryE6: pos.effectiveEntryPrice, source: pos.entryPriceSource }).known,
    formatPrice: (p) => formatMarkPrice(Number(p) / 1e6),
    unknownText: "—",
  });
  const danger = severity === "danger";
  const tone = danger ? "var(--short)" : "var(--warning)";
  const size = pos.effectiveSize;
  const label = riskLabel(pos);
  // Full at the warning line, empty at liquidation.
  const gauge = Math.max(0, Math.min(1, distancePct / LIQ_WARNING_PCT)) * 100;

  return (
    <div
      className="relative border border-[var(--border)] bg-[var(--panel-bg)] pl-3 pr-3 py-2.5"
      style={{ boxShadow: `inset 2px 0 0 ${tone}` }}
      data-severity={severity}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium text-[var(--text)]">{label}</span>
            <span
              className="text-[10px] font-medium uppercase tracking-[0.08em]"
              style={{ color: size > 0n ? "var(--long)" : "var(--short)" }}
            >
              {size > 0n ? "Long" : "Short"}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-[11px] tabular-nums text-[var(--text-secondary)]">
            Mark {formatMarkPrice(Number(markE6) / 1e6)}
            <span className="mx-1.5 text-[var(--text-dim)]">→</span>
            Liq <LiqPriceValue display={liqDisplay} />
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div
            className="font-mono text-[18px] font-semibold leading-none tabular-nums"
            style={{ color: tone }}
          >
            {distancePct.toFixed(1)}%
          </div>
          <div className="mt-1 text-[10px] text-[var(--text-secondary)]">from liquidation</div>
        </div>
      </div>

      <div className="mt-2 h-[3px] w-full bg-[var(--border)]" aria-hidden>
        <div
          className="h-full transition-[width] duration-500"
          style={{ width: `${gauge}%`, background: tone }}
        />
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <Link
          href={`/trade/${pos.slabAddress}`}
          className="inline-flex min-h-[44px] md:min-h-[30px] items-center border border-[var(--border)] px-2.5 text-[11px] text-[var(--text)] transition-colors hover:border-[var(--text-secondary)]"
        >
          Go to market
        </Link>
        {pos.nftWrapped ? (
          <span
            className="text-[11px] text-[var(--text-secondary)]"
            title="This position is wrapped in a Position NFT. Burn the NFT on its market's trade page to unwrap it, then close."
          >
            Wrapped in an NFT: unwrap on its market to close
          </span>
        ) : onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[30px] items-center border px-2.5 text-[11px] transition-colors"
            style={{ borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`, color: tone }}
          >
            Close position
          </button>
        ) : null}
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="ml-auto text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]"
            aria-label={`Hide the warning for ${label}`}
          >
            Hide
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The close modal for one at-risk position, with its market's SlabProvider mounted on demand.
 * Rendered by the parent outside the risk list, so a tick that moves the position out of range
 * (or a re-sort) can't unmount it mid-close. Nothing is sent until Confirm, then the wallet.
 */
export function RiskCloseFlow({
  risk,
  onDone,
}: {
  risk: LiquidationRisk;
  onDone: (closed: boolean) => void;
}) {
  const { pos, decimals } = risk;
  const subscribe = useCallback((cb: () => void) => subscribeSlab(pos.slabAddress, cb), [pos.slabAddress]);
  const getLive = useCallback(() => getSnapshot(pos.slabAddress).priceE6, [pos.slabAddress]);
  const live = useSyncExternalStore(subscribe, getLive, () => null);
  const markE6 = live != null && live > 0n ? live : risk.markE6;
  return (
    <SlabProvider slabAddress={pos.slabAddress}>
      <CloseFlow
        pos={pos}
        markE6={markE6}
        priceUsd={markE6 > 0n ? Number(markE6) / 1e6 : null}
        symbol={riskLabel(pos)}
        decimals={decimals}
        onDone={onDone}
      />
    </SlabProvider>
  );
}

/**
 * Open positions within the warning distance at the live mark, closest to liquidation first.
 * A position with no size is skipped (flat/idle rows carry no risk).
 */
export function collectLiquidationRisks(
  positions: readonly PortfolioPosition[],
  livePrices: ReadonlyMap<string, bigint> | undefined,
  decimalsOf: (pos: PortfolioPosition) => number = () => 6,
): LiquidationRisk[] {
  const risks: LiquidationRisk[] = [];
  for (const pos of positions) {
    if ((pos.account?.positionSize ?? 0n) === 0n) continue;
    const live = livePrices?.get(pos.slabAddress);
    const distancePct = liveLiquidationDistancePct(pos, live);
    const severity = getLiquidationSeverity(distancePct);
    if (severity === "safe") continue;
    const markE6 = live != null && live > 0n ? live : pos.oraclePriceE6;
    risks.push({ pos, distancePct, severity, markE6, decimals: decimalsOf(pos) });
  }
  return risks.sort((a, b) => a.distancePct - b.distancePct);
}
