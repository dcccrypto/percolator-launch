/**
 * THE one place an open position's effective size, entry, unrealized PnL and ROE
 * are computed (issue #3077).
 *
 * Before this existed, five surfaces (positions bar, chart badge, positions
 * dock, portfolio card, share card) each re-derived the chain and drifted apart:
 *
 *   - by ENTRY: each resolved cache -> back-solve on its own (cross-device
 *     opposite sign, = percolator-indexer#211);
 *   - by SIZE: the dock back-solved over raw basis while computing PnL over the
 *     ADL-effective size (#3078/#3081);
 *   - by ADL FALLBACK: `usePortfolio` fell back to RAW basis whenever the ADL
 *     factors read null, so the bar showed ADL-factor x what the chart showed
 *     (+104 vs +17).
 *
 * Rules enforced here, so no surface can opt out:
 *
 *   1. Unrealized PnL is always valued at the MARK (what liquidation uses).
 *   2. Exposure is the ADL-EFFECTIVE size. If the per-side ADL factors are
 *      unknown on a market that may have been deleveraged we DO NOT fall back to
 *      raw basis - raw basis is exactly the wrong number on a deleveraged leg.
 *      The result is `pnlKnown: false` and surfaces render "--".
 *   3. Entry priority is `server` > `cache` > `derived` > `unknown`. The derived
 *      entry is back-solved over the effective size and is only an ESTIMATE
 *      (`isEstimate`); every surface labels it "est." (ESTIMATE_LABEL).
 *   4. ROE divides by the position's own initial margin on EFFECTIVE size (the
 *      engine's risk_notional runs over effective_abs_q), falling back to capital.
 *   5. The effective size mirrors the engine's `effective_abs_quantity_for_leg`
 *      (lib/limits/effective-quantity.ts): a leg whose factors are invalid
 *      (a_side > a_basis, a_basis out of range) or whose epoch no longer matches
 *      the side is UNKNOWN; a prior-reset obligation owns 0 and its PnL is
 *      withheld (it settles at the next refresh).
 *   6. The liquidation price is computed on effective size too.
 *
 * Pure: no React, no storage, no network. Callers fetch the inputs.
 */
import { computeMarkPnl, computePnlPercent } from "@percolatorct/sdk";
import {
  computeMarkPnlCollateral,
  computePositionInitialMargin,
  resolveEntryPrice,
  type EntryPriceSource,
} from "@/lib/trading";
import { isSentinelValue } from "@/lib/health";
import { getEntryPrice } from "@/lib/entry-price";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import type { AssetAdlFactors } from "@/lib/v17-adl";
import { adlEffectiveQuantityCeil, effectiveLeg } from "@/lib/limits/effective-quantity";
import { computeEngineLiqPrice } from "@/lib/liquidation-risk";

export interface PositionPnlInput {
  /** RAW leg basis (`account.positionSize`, signed). Never pre-scaled by ADL. */
  basisQ: bigint;
  /** The leg's frozen `a_basis` (`account.adlABasis`). */
  aBasis: bigint;
  /**
   * The leg's `epoch_snap` (`account.adlEpochSnap`). With the factors' side
   * epochs/modes it lets us mirror the engine's `effective_abs_quantity_for_leg`
   * (current epoch scales, a prior-reset obligation owns 0, anything else is invalid).
   */
  epochSnap?: bigint;
  /** Live per-side ADL factors for the asset slot; `null` = unknown. */
  adlFactors: AssetAdlFactors | null;
  /**
   * false only for legacy v12.x engines, which have no ADL concept - raw basis
   * IS the exposure there, so `adlFactors: null` is not "unknown".
   */
  adlApplicable?: boolean;
  /** Mark price, e6, in the SAME (post-inversion) domain as the entry. */
  markE6: bigint;
  /**
   * The on-chain mark the position's `onChainPnl` was observed at (the slab's
   * `markEwmaE6`). A back-solved entry is `anchor -/+ pnl/size`, then VALUED at
   * `markE6`, so the estimate moves with the live mark instead of freezing at
   * `onChainPnl`. Every surface passes the same on-chain mark, so they agree.
   * Defaults to `markE6`.
   */
  anchorMarkE6?: bigint;
  /** Indexer-recorded open price (percolator-indexer#211). Top priority. */
  serverEntryE6?: bigint | null;
  /** Entry cached on this device at open. */
  cachedEntryE6?: bigint | null;
  /** On-chain `account.pnl` (collateral atoms) - only used to back-solve. */
  onChainPnl: bigint;
  initialMarginBps: bigint;
  /** Maintenance margin bps, for the liquidation price. Omit when not needed. */
  maintenanceMarginBps?: bigint;
  /** Fallback ROE denominator when no initial margin is computable. */
  capital: bigint;
}

export interface PositionPnl {
  /** ADL-effective exposure, or `null` when the ADL state is unknown. */
  effectiveSize: bigint | null;
  /** false => ADL factors unknown on a non-flat position; nothing about size/PnL is trustworthy. */
  adlKnown: boolean;
  /** Best entry for RISK math (falls back to the mark). DISPLAY must gate on `entrySource`/`pnlKnown`. */
  entry: bigint;
  entrySource: EntryPriceSource;
  /** Entry is a back-solve - show "est." beside anything computed from it. */
  isEstimate: boolean;
  /** True when `unrealizedPnl`/`roe` are real numbers that may be displayed. */
  pnlKnown: boolean;
  /** Coin-margined native PnL (same scale as size), or null when unknown. */
  pnlNative: bigint | null;
  /** Collateral-scale PnL at the mark, or null when unknown. */
  unrealizedPnl: bigint | null;
  /** Return on initial margin, percent, or null when unknown. */
  roe: number | null;
  /**
   * Engine liquidation price (e6) on EFFECTIVE size - the engine's maintenance
   * check runs over `effective_abs_q` (v16.rs:13896-13912). 0n = none; `null` =
   * size unknown (never computed from raw basis) or no maintenance bps supplied.
   */
  liquidationPriceE6: bigint | null;
}

/**
 * The arithmetic core, shared by `computePositionPnl` and any surface that is
 * handed an ALREADY-resolved (effective size, entry) pair - the PnL share card.
 * Everything that turns (size, entry, mark) into PnL/ROE lives here and only
 * here: mark-valued, coin-margined native -> collateral once, ROE on
 * initial margin on EFFECTIVE size (the engine's risk_notional runs over
 * effective_abs_q, v16.rs:13896-13912).
 */
export function valueAtMark(v: {
  effectiveSize: bigint;
  entryE6: bigint;
  markE6: bigint;
  initialMarginBps: bigint;
  capital: bigint;
}): { pnlNative: bigint; unrealizedPnl: bigint; roe: number } {
  const pnlNative = computeMarkPnl(v.effectiveSize, v.entryE6, v.markE6);
  const unrealizedPnl = computeMarkPnlCollateral(pnlNative, v.markE6);
  let roe = 0;
  try {
    const margin = computePositionInitialMargin(v.effectiveSize, v.entryE6, v.initialMarginBps);
    if (margin > 0n) roe = computePnlPercent(unrealizedPnl, margin);
    else if (v.capital > 0n) roe = computePnlPercent(unrealizedPnl, v.capital);
  } catch {
    // dust margin + huge PnL overflows computePnlPercent; ROE is cosmetic.
    roe = 0;
  }
  if (!Number.isFinite(roe)) roe = 0;
  return { pnlNative, unrealizedPnl, roe };
}

export function computePositionPnl(input: PositionPnlInput): PositionPnl {
  const { basisQ, aBasis, adlFactors, markE6 } = input;
  const adlApplicable = input.adlApplicable !== false;
  const flat = basisQ === 0n;

  // Effective exposure, mirroring the engine (see header, rule 5).
  let effectiveSize: bigint | null;
  let resetObligation = false;
  if (flat) {
    effectiveSize = 0n;
  } else if (!adlApplicable) {
    effectiveSize = basisQ;
  } else if (adlFactors === null) {
    effectiveSize = null;
  } else {
    const long = basisQ > 0n;
    const hasEpochs =
      input.epochSnap !== undefined &&
      adlFactors.epochLong !== undefined &&
      adlFactors.epochShort !== undefined &&
      adlFactors.modeLong !== undefined &&
      adlFactors.modeShort !== undefined;
    if (hasEpochs) {
      const leg = effectiveLeg(
        {
          aLong: adlFactors.aLong,
          aShort: adlFactors.aShort,
          epochLong: adlFactors.epochLong as bigint,
          epochShort: adlFactors.epochShort as bigint,
          modeLong: adlFactors.modeLong as number,
          modeShort: adlFactors.modeShort as number,
        },
        { active: true, side: long ? 0 : 1, basisPosQ: basisQ, aBasis, epochSnap: input.epochSnap as bigint },
      );
      if (leg.kind === "live") effectiveSize = leg.signedQ;
      else if (leg.kind === "reset") {
        effectiveSize = 0n;
        resetObligation = true;
      } else effectiveSize = null;
    } else {
      const abs = adlEffectiveQuantityCeil(basisQ < 0n ? -basisQ : basisQ, aBasis, (long ? adlFactors.aLong : adlFactors.aShort));
      effectiveSize = abs === null ? null : long ? abs : -abs;
    }
  }
  const adlKnown = effectiveSize !== null;

  const anchorE6 = input.anchorMarkE6 != null && input.anchorMarkE6 > 0n ? input.anchorMarkE6 : markE6;
  const safePnl = isSentinelValue(input.onChainPnl) ? 0n : input.onChainPnl;
  const server = input.serverEntryE6 ?? 0n;
  const cached = input.cachedEntryE6 ?? 0n;

  // Back-solve over EFFECTIVE size (the size the on-chain pnl was earned on).
  // With the size unknown a back-solve is impossible, and passing raw basis
  // would re-introduce the very error this module exists to prevent - so a
  // recorded entry (server/cache) is still honoured, the back-solve is not.
  const resolved =
    effectiveSize === null
      ? server > 0n
        ? ({ entry: server, source: "server" } as const)
        : cached > 0n
          ? ({ entry: cached, source: "cache" } as const)
          : ({ entry: anchorE6, source: "unknown" } as const)
      : resolveEntryPrice(effectiveSize, cached, safePnl, anchorE6, server);

  const base = {
    effectiveSize,
    adlKnown,
    entry: resolved.entry,
    entrySource: resolved.source,
    isEstimate: resolved.source === "derived",
    liquidationPriceE6:
      effectiveSize === null || input.maintenanceMarginBps === undefined
        ? null
        : computeEngineLiqPrice(resolved.entry, input.capital, effectiveSize, input.maintenanceMarginBps),
  };
  const unknown: PositionPnl = {
    ...base,
    pnlKnown: false,
    pnlNative: null,
    unrealizedPnl: null,
    roe: null,
  };

  if (flat) return { ...base, pnlKnown: true, pnlNative: 0n, unrealizedPnl: 0n, roe: 0 };
  if (effectiveSize === null || resetObligation) return unknown;
  if (resolved.source === "unknown" || resolved.entry <= 0n || markE6 <= 0n) return unknown;

  const valued = valueAtMark({
    effectiveSize,
    entryE6: resolved.entry,
    markE6,
    initialMarginBps: input.initialMarginBps,
    capital: input.capital,
  });
  const { pnlNative, unrealizedPnl, roe } = valued;

  return { ...base, pnlKnown: true, pnlNative, unrealizedPnl, roe };
}

/**
 * Where a position's recorded entries come from. EVERY surface calls this, so
 * landing the server-authoritative entry (percolator-indexer#211) is a ONE-LINE
 * change here: replace `serverEntryE6: null` with the lookup.
 */
export function lookupKnownEntries(
  slab: string,
  accountIdx: number,
  wallet: string,
  /** #2560: the portfolio pubkey, so multiple portfolios on one market read
   *  their OWN cached entry instead of colliding on `{slab}:0:{wallet}`. */
  portfolio?: string,
  /** false for a NON-primary (isolated) portfolio, so it can't read the
   *  primary's entry via the legacy fallback (see lib/entry-price.ts). */
  allowLegacyFallback = true,
): { serverEntryE6: bigint | null; cachedEntryE6: bigint } {
  return {
    serverEntryE6: null, // TODO(indexer#211): server-authoritative entry slots in here
    cachedEntryE6: getEntryPrice(slab, accountIdx, wallet, portfolio, allowLegacyFallback),
  };
}

/** Structural subset of `PortfolioPosition` the adapter needs (avoids a lib -> hook import cycle). */
export interface PortfolioPnlSource {
  account: { positionSize: bigint; adlABasis: bigint; adlEpochSnap?: bigint; pnl: bigint; capital: bigint } | null;
  adlFactors?: AssetAdlFactors | null;
  /** false on legacy v12.x portfolio rows. */
  adlApplicable?: boolean;
  /** The entry the poll resolved; exact sources (server/cache) are re-fed, estimates are re-derived. */
  effectiveEntryPrice: bigint;
  entryPriceSource: EntryPriceSource;
  initialMarginBps: bigint;
  maintenanceMarginBps?: bigint;
  oraclePriceE6: bigint;
}

/** Live-mark PnL for a polled `PortfolioPosition` - what the bar, card, hero totals and metrics all call. */
export function portfolioPositionPnl(pos: PortfolioPnlSource, liveMarkE6: bigint | null | undefined): PositionPnl {
  const markE6 = liveMarkE6 != null && liveMarkE6 > 0n ? liveMarkE6 : pos.oraclePriceE6;
  return computePositionPnl({
    basisQ: pos.account?.positionSize ?? 0n,
    aBasis: pos.account?.adlABasis ?? 0n,
    epochSnap: pos.account?.adlEpochSnap,
    adlFactors: pos.adlFactors ?? null,
    adlApplicable: pos.adlApplicable !== false,
    markE6,
    anchorMarkE6: pos.oraclePriceE6,
    serverEntryE6: pos.entryPriceSource === "server" ? pos.effectiveEntryPrice : null,
    cachedEntryE6: pos.entryPriceSource === "cache" ? pos.effectiveEntryPrice : 0n,
    onChainPnl: pos.account?.pnl ?? 0n,
    initialMarginBps: pos.initialMarginBps,
    maintenanceMarginBps: pos.maintenanceMarginBps,
    capital: pos.account?.capital ?? 0n,
  });
}

/** Structural subset of an SDK `Account` the trade-terminal surfaces hold. */
export interface TerminalPnlAccount {
  positionSize: bigint;
  adlABasis: bigint;
  adlEpochSnap?: bigint;
  pnl: bigint;
  capital: bigint;
  /** On-chain entry (v12.x only; always 0n on v17/v18). */
  entryPrice?: bigint;
  owner: { toBase58(): string };
}

/**
 * Trade-terminal adapter (ChartPnlBadge, PositionsDock, PositionPanel): the same
 * `computePositionPnl`, fed from the slab-provider account + factors. Resolves
 * the recorded entries through `lookupKnownEntries` so the server-authoritative
 * entry (indexer#211) reaches every terminal surface from the one place.
 */
export function terminalPositionPnl(args: {
  account: TerminalPnlAccount;
  slabAddress: string;
  accountIdx: number;
  adlFactors: AssetAdlFactors | null;
  /** true for v17/v18 slabs; false for legacy v12.x, which has no ADL. */
  adlApplicable: boolean;
  markE6: bigint;
  /** On-chain mark `account.pnl` was observed at; see PositionPnlInput.anchorMarkE6. */
  anchorMarkE6?: bigint;
  initialMarginBps: bigint;
  maintenanceMarginBps?: bigint;
  /** #2560: the portfolio pubkey, so a specific portfolio reads its own cached
   *  entry. Omitted → today's `{slab}:0:{wallet}` key (single-portfolio). */
  portfolio?: string;
  /** false when `portfolio` is a NON-primary (isolated) account, so the entry
   *  read can't fall back to the primary's legacy entry. */
  allowLegacyEntryFallback?: boolean;
}): PositionPnl {
  const { account } = args;
  const known = lookupKnownEntries(
    args.slabAddress,
    args.accountIdx,
    account.owner?.toBase58?.() ?? "",
    args.portfolio,
    args.allowLegacyEntryFallback ?? true,
  );
  const onChainEntry = account.entryPrice ?? 0n;
  return computePositionPnl({
    basisQ: account.positionSize,
    // `?? 0n`: a partial/legacy account shape has no frozen factor; 0n means "no scaling".
    aBasis: account.adlABasis ?? 0n,
    epochSnap: account.adlEpochSnap,
    adlFactors: args.adlFactors,
    adlApplicable: args.adlApplicable,
    markE6: args.markE6,
    anchorMarkE6: args.anchorMarkE6,
    serverEntryE6: known.serverEntryE6,
    cachedEntryE6: onChainEntry > 0n ? onChainEntry : known.cachedEntryE6,
    onChainPnl: account.pnl,
    initialMarginBps: args.initialMarginBps,
    maintenanceMarginBps: args.maintenanceMarginBps,
    capital: account.capital,
  });
}

/**
 * The slab's on-chain mark in the engine's price domain.
 *
 * On v17/v18 `markEwmaE6` is ALREADY post-inversion: the wrapper applies
 * `invert` while composing the oracle price (percolator-prog v16_program.rs
 * compose_price_e6, :6440-6445) and the EWMA/AUTH_MARK modes require
 * `invert == 0`. Applying the flag again double-inverts (and `usePortfolio`
 * never did, so surfaces disagreed). Only legacy v12.x stores a raw price that
 * the flag still applies to (GH#1990).
 */
export function onChainMarkE6(
  config: { lastEffectivePriceE6: bigint; invert?: number } | null | undefined,
  isV17: boolean,
): bigint | null {
  if (!config) return null;
  const raw = sanitizePriceE6(config.lastEffectivePriceE6);
  return isV17 ? raw : sanitizePriceE6(applyInvert(config.lastEffectivePriceE6, config.invert));
}

/**
 * Calm caveat for any aggregate (hero / dashboard totals) that cannot include
 * positions whose PnL is unknown. Never sum an unknown as 0 without saying so.
 */
export function unknownPnlCaveat(unknownCount: number): string | null {
  if (!Number.isFinite(unknownCount) || unknownCount <= 0) return null;
  return unknownCount === 1
    ? "Excludes 1 position whose PnL isn't available yet"
    : `Excludes ${unknownCount} positions whose PnL isn't available yet`;
}
