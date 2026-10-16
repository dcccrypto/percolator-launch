/**
 * Graduation, liquidity tier and "what unlocks next" for a growth market (pure, never throws).
 *
 * Model: ledger v22-leverage-tiers-explainer-2026-10-14.md. A market starts at the creator's launch leverage and earns higher tiers
 * as two things grow: the token pool's depth and the money backing the market. Tier = the lower of the two. The math is the SDK's
 * (percolator-sdk `feat/v22-sdk-growth` @ 6871426), ported in lib/v22/sdk/records/growth-v19.ts (TODO(repin) there); this module
 * only adapts `growthCeilingView` for the ticket and turns its answer into one calm line.
 *
 * What the user sees (and does not): a tier 0..3 badge, one "what unlocks next" line, and (once a depth reading has been seen and
 * then stops arriving) one calm "reading out of date" line, only on a market whose ceiling can graduate (a band market with the
 * clamp enforced). Never a raw bps / x100 number. An off-band market has a fixed ceiling, so it gets none of it.
 */
import { conservativeEquity } from "../v21/sdk";
import type { GrowthMarketView } from "../v21/growth-market";
import { V22_COPY } from "./copy";
import { TEST_USDC, amountLabel, type TierCollateral } from "./tier-config";
import {
  DEPTH_EVER,
  DEPTH_PREV_REAL,
  freshDepthE6,
  growthCeilingView,
  type NextUnlock,
} from "./sdk/records/growth-v19";

export type { NextUnlock };
export type DepthTier = 0 | 1 | 2 | 3;

export interface GrowthUnlockView {
  /** The leverage ceiling can graduate on this market (band market, clamp enforced). */
  graduation: boolean;
  /** Null while the clock is unknown, or when graduation is off (no tier is shown there). */
  tier: DepthTier | null;
  unlock: NextUnlock | null;
  /**
   * A depth reading was seen before and has stopped arriving (stale or missing): the program keeps capping new positions on the
   * last good reading, shrinking each hour. A fresh real zero is NOT this (that is a full side, and the full-side lines cover it).
   */
  sticky: boolean;
}

export const NO_UNLOCK: GrowthUnlockView = { graduation: false, tier: null, unlock: null, sticky: false };

export interface GrowthUnlockInput {
  view: GrowthMarketView;
  /** Engine `band_bps` of the asset (0 = not a band market). */
  bandBps: number;
  /** Cluster slot; null while unknown (then no tier or unlock is claimed). */
  nowSlot: bigint | null;
}

export function growthUnlockView(i: GrowthUnlockInput): GrowthUnlockView {
  const g = i.view.record;
  // Off-band (or r_gap not the derived one): nothing is said. Decided without the clock so it never flickers.
  const probe = growthCeilingView(g, i.bandBps, 0n, null, true);
  if (!probe.clampEnforced) return NO_UNLOCK;
  if (i.nowSlot === null) return { graduation: true, tier: null, unlock: null, sticky: false };

  const q = i.view.quoteInput;
  const cM = conservativeEquity(q.lpCapital, q.lpPnl, q.lpFeeCredits);
  const cv = growthCeilingView(g, i.bandBps, i.nowSlot, cM, i.view.hlockActive);
  const dsByte = g.depthSource | (g.depthEver ? DEPTH_EVER : 0) | (g.depthPrevReal ? DEPTH_PREV_REAL : 0);
  const fresh = freshDepthE6(g.depthE6, g.depthPrevE6, g.depthSlot, dsByte, i.nowSlot);
  const sticky = g.depthEver && fresh === null;
  const base = { graduation: true, tier: cv.tier as DepthTier, sticky };
  if (i.view.hlockActive) return { ...base, unlock: null };
  // The pool is deep enough for the next tier but the usable reading may rise only 2x per hour: one line, and when the +1x climb is
  // also pending, the LATER of the two waits (the next tier's leverage needs both to be done).
  const tierNext = cv.nextTierUnlock;
  if (tierNext.depthRateLimited && tierNext.depthEtaMinutes !== undefined && tierNext.leverageX100 !== undefined && !tierNext.needsOnChainDepth) {
    let minutes = tierNext.depthEtaMinutes;
    const climb = cv.nextUnlock;
    if (climb.kind === "ratchet" && climb.leverageX100 !== undefined && climb.etaMinutes !== undefined) {
      const stepsAfterFirst = Math.max(0, Math.ceil((tierNext.leverageX100 - climb.leverageX100) / 100));
      minutes = Math.max(minutes, climb.etaMinutes + stepsAfterFirst * 60);
    }
    return { ...base, unlock: { ...tierNext, depthEtaMinutes: minutes } };
  }
  return { ...base, unlock: cv.nextUnlock.kind === "none" ? null : cv.nextUnlock };
}

// -- copy -------------------------------------------------------------------------------------------------------

const xLabel = (x100: number): string => `${x100 % 100 === 0 ? x100 / 100 : (x100 / 100).toFixed(1)}x`;

/** "$25k", "$1.5M": whole thousands read as k. */
export function compactUsd(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd % 1_000_000 === 0 ? 0 : 1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(usd % 1_000 === 0 ? 0 : 1)}k`;
  return `$${Math.round(usd)}`;
}

/** "about 7 minutes", "about an hour", "about 2 hours". */
export function waitLabel(minutes: number): string {
  if (minutes >= 90) return `about ${Math.round(minutes / 60)} hours`;
  if (minutes >= 55) return "about an hour";
  return minutes <= 1 ? "about a minute" : `about ${Math.ceil(minutes)} minutes`;
}

/**
 * The single calm line for the next unlock, or null. A tier that keeper-reported depth can never reach (needs an on-chain pool
 * reading) is not promised: no line.
 */
export function unlockLine(u: NextUnlock | null, collateral: TierCollateral = TEST_USDC): string | null {
  if (!u || u.kind === "none" || u.leverageX100 === undefined) return null;
  const x = xLabel(u.leverageX100);
  if (u.kind === "ratchet") {
    return u.etaSlots === undefined || u.etaSlots === 0n || u.etaMinutes === undefined
      ? V22_COPY.growth.nextStepNow(x)
      : V22_COPY.growth.nextStepAfter(x, waitLabel(u.etaMinutes));
  }
  if (u.needsOnChainDepth) return null;
  const money = (n: number): string => amountLabel(n, collateral);
  // Pool depth already there, only the hourly limit on the usable reading is left: one line with the wait. (With the backing also
  // short, the backing is the thing to name.)
  if (u.kind === "depth" && u.depthRateLimited && u.depthEtaMinutes !== undefined) {
    return u.depthEtaMinutes === 0 ? V22_COPY.growth.unlockCatchUpNow(x) : V22_COPY.growth.unlockCatchUp(x, waitLabel(u.depthEtaMinutes));
  }
  if (u.kind === "both" && u.depthRateLimited && u.backingUsd !== undefined) return V22_COPY.growth.unlockBacking(x, money(u.backingUsd));
  if (u.kind === "both" && u.depthUsd !== undefined && u.backingUsd !== undefined) {
    return V22_COPY.growth.unlockBoth(x, money(u.depthUsd), money(u.backingUsd));
  }
  if (u.kind === "depth" && u.depthUsd !== undefined) return V22_COPY.growth.unlockDepth(x, money(u.depthUsd));
  if (u.kind === "backing" && u.backingUsd !== undefined) return V22_COPY.growth.unlockBacking(x, money(u.backingUsd));
  return null;
}
