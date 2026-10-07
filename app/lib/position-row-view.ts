/**
 * The per-row derivation for a single portfolio's position, factored out of
 * PositionsDock's PositionRow so the single-portfolio row and the multi-row
 * (isolated-margin, #2560) table compute EXACTLY the same numbers — they can't
 * drift because they call this one function. Pure (no React / no hooks), so it
 * is unit-testable without a render tree.
 *
 * It is a faithful move of PositionRow's inline derivation: every value comes
 * from the same shared primitives (terminalPositionPnl, describeLiqPrice,
 * computePositionLeverage, the ADL helpers, the pool-cap helpers), threaded with
 * the portfolio pubkey so each portfolio reads its OWN cached entry.
 */
import type { Account } from "@percolatorct/sdk";
import { computeMarginCushion, severityFromCushion } from "@/lib/liquidation-risk";
import { onChainMarkE6, terminalPositionPnl } from "@/lib/position-pnl";
import { isEntryKnown, isExactEntrySource } from "@/lib/entry-price-display";
import { adlSideFactor, isDeleveraged, adlRemainingBps, type AssetAdlFactors } from "@/lib/v17-adl";
import { bigintToFloat } from "@/lib/formatters";
import { isPnlPoolCapped, poolPayableCapacity, type PnlCardData } from "@/lib/pnl-card";
import { computePositionLeverage, describePositionLeverage } from "@/lib/position-leverage";
import { describeLiqPrice, type LiqPriceDisplay } from "@/lib/liq-price-display";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export interface PositionRowViewDeps {
  account: Account;
  accountIdx: number;
  slabAddress: string;
  /** The portfolio account's base58 pubkey — scopes the cached-entry read. */
  portfolio?: string;
  /** True only for the PRIMARY (lowest-pubkey / cross) portfolio: lets the
   *  cached-entry read fall back to the legacy unscoped key (which holds the
   *  primary's entry until the write side is scoped). Non-primary (isolated)
   *  rows pass false so they never read the primary's entry. */
  isPrimary: boolean;
  config: { lastEffectivePriceE6: bigint; invert?: number } | null | undefined;
  /** `wrapperConfigV17 !== null` — true for v17/v18 (ADL applies). */
  adlApplicable: boolean;
  adlFactors: AssetAdlFactors | null;
  livePriceE6: bigint | null | undefined;
  maintenanceMarginBps?: bigint;
  initialMarginBps?: bigint;
  /** `engine?.vault` (v12-only; null on v17). */
  engineVault: bigint | null | undefined;
  insuranceBalance: bigint | null | undefined;
  decimals: number;
  marketInfo: { name?: string | null; logo_url?: string | null; mainnet_ca?: string | null } | null;
  /** Ticker already stripped of any "-PERP" suffix. */
  marketDisplaySymbol: string;
}

export interface PositionRowView {
  isLong: boolean;
  wasDeleveraged: boolean;
  adlRemaining: number;
  /** Nominal basis magnitude (ADL-reduction display only). */
  absNominal: bigint;
  /** ADL-effective signed size. */
  effectiveSize: bigint;
  absPosition: bigint;
  currentPriceE6: bigint;
  hasValidMark: boolean;
  maintenanceBps: bigint;
  entryPriceE6: bigint;
  entryKnown: boolean;
  pnlIsKnown: boolean;
  /** true when the shown entry is a back-solved estimate, not cache/server. */
  isEstimate: boolean;
  adlKnown: boolean;
  pnlTokens: bigint;
  pnlUsd: number | null;
  roe: number;
  payableCapacity: bigint;
  pnlIsCapped: boolean;
  leverage: ReturnType<typeof describePositionLeverage>;
  liqDisplay: LiqPriceDisplay;
  liqPriceColor: string;
  pnlColor: string;
  roeColor: string;
  pnlCardData: PnlCardData | null;
}

/**
 * Derive everything one position row renders. Mirrors PositionsDock's PositionRow
 * body (the block that begins `const isLong = account.positionSize > 0n`).
 */
export function computePositionRowView(deps: PositionRowViewDeps): PositionRowView {
  const { account, adlFactors } = deps;
  const isLong = account.positionSize > 0n;

  const aSide = adlFactors ? adlSideFactor(adlFactors, isLong ? 0 : 1) : 0n;
  const wasDeleveraged = !!adlFactors && isDeleveraged(account.adlABasis, aSide);
  const adlRemaining = adlFactors ? adlRemainingBps(account.adlABasis, aSide) : 10000;
  const absNominal = abs(account.positionSize);

  const onChainPriceE6 = onChainMarkE6(deps.config, deps.adlApplicable);
  const currentPriceE6 = deps.livePriceE6 ?? onChainPriceE6 ?? 0n;
  const maintenanceBps = deps.maintenanceMarginBps ?? 500n;
  const initialMarginBps = deps.initialMarginBps ?? 1000n;
  const hasValidMark = currentPriceE6 > 0n;

  const pnlResult = terminalPositionPnl({
    account,
    slabAddress: deps.slabAddress,
    accountIdx: deps.accountIdx,
    adlFactors,
    adlApplicable: deps.adlApplicable,
    markE6: currentPriceE6,
    anchorMarkE6: onChainPriceE6 ?? undefined,
    initialMarginBps,
    maintenanceMarginBps: maintenanceBps,
    portfolio: deps.portfolio,
    allowLegacyEntryFallback: deps.isPrimary,
  });

  const effectiveSize = pnlResult.effectiveSize ?? account.positionSize;
  const absPosition = abs(effectiveSize);
  const entryPriceE6 = pnlResult.entry;
  const pnlIsKnown = pnlResult.pnlKnown;
  const entryKnown = isEntryKnown(pnlResult.entry, pnlResult.entrySource);
  const pnlTokens = pnlResult.unrealizedPnl ?? 0n;
  const pnlUsdRaw = hasValidMark ? bigintToFloat(pnlTokens, deps.decimals) : null;
  const pnlUsd = pnlUsdRaw !== null && Number.isFinite(pnlUsdRaw) ? pnlUsdRaw : null;
  const roe = pnlResult.roe ?? 0;

  const payableCapacity = poolPayableCapacity(deps.engineVault, deps.insuranceBalance);
  const pnlIsCapped = hasValidMark && isPnlPoolCapped(pnlTokens, payableCapacity);

  const leverage = describePositionLeverage(
    computePositionLeverage({
      sizeQ: account.positionSize,
      markPriceE6: hasValidMark ? currentPriceE6 : null,
      capital: account.capital,
      pnl: account.pnl,
      collateralDecimals: deps.decimals,
    }),
  );

  const liqPriceE6 = pnlResult.liquidationPriceE6 ?? 0n;
  const liqUnliquidatable = pnlResult.adlKnown && liqPriceE6 <= 0n && entryPriceE6 > 0n && account.positionSize !== 0n;
  const liqDisplay = describeLiqPrice({
    liqPriceE6,
    positionSize: account.positionSize,
    capital: account.capital,
    markPriceE6: currentPriceE6,
    maintenanceMarginBps: maintenanceBps,
    hasResolvedEntry: pnlIsKnown,
  });

  const liqPriceColor = (() => {
    if (liqUnliquidatable) return "text-[var(--text-secondary)]";
    if (liqPriceE6 <= 0n) return "text-[var(--text-secondary)]";
    if (!hasValidMark || currentPriceE6 <= 0n) return "text-[var(--warning)]";
    const cushion =
      pnlResult.effectiveSize === null
        ? null
        : computeMarginCushion({
            positionSize: pnlResult.effectiveSize,
            entryPriceE6,
            capital: account.capital,
            markPriceE6: currentPriceE6,
            maintenanceMarginBps: maintenanceBps,
            initialMarginBps,
          });
    const tier = cushion == null ? "safe" : severityFromCushion(cushion);
    if (tier === "danger") return "text-[var(--short)]";
    if (tier === "warning") return "text-[var(--warning)]";
    return "text-[var(--text-secondary)]";
  })();

  const pnlColor = pnlTokens === 0n ? "text-[var(--text-muted)]" : pnlTokens > 0n ? "text-[var(--long)]" : "text-[var(--short)]";
  const roeColor = roe === 0 ? "text-[var(--text-muted)]" : roe > 0 ? "text-[var(--long)]" : "text-[var(--short)]";

  const pnlCardData: PnlCardData | null =
    hasValidMark && pnlIsKnown && isExactEntrySource(pnlResult.entrySource) && entryPriceE6 > 0n
      ? {
          slab: deps.slabAddress,
          symbol: deps.marketDisplaySymbol,
          name: deps.marketInfo?.name ?? deps.marketDisplaySymbol,
          logoUrl: deps.marketInfo?.logo_url ?? null,
          mainnetCa: deps.marketInfo?.mainnet_ca ?? null,
          payableCapacityAtoms: payableCapacity,
          decimals: deps.decimals,
          nominalSizeQ: account.positionSize,
          effectiveSizeQ: effectiveSize,
          entryE6: entryPriceE6,
          initialMarginBps,
          initialMarkE6: currentPriceE6,
        }
      : null;

  return {
    isLong,
    wasDeleveraged,
    adlRemaining,
    absNominal,
    effectiveSize,
    absPosition,
    currentPriceE6,
    hasValidMark,
    maintenanceBps,
    entryPriceE6,
    entryKnown,
    pnlIsKnown,
    isEstimate: pnlResult.isEstimate,
    adlKnown: pnlResult.adlKnown,
    pnlTokens,
    pnlUsd,
    roe,
    payableCapacity,
    pnlIsCapped,
    leverage,
    liqDisplay,
    liqPriceColor,
    pnlColor,
    roeColor,
    pnlCardData,
  };
}
