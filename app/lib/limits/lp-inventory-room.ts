/**
 * The LP's room on a side, from its REAL engine position — the matcher-inventory-drift fix
 * (~/percolator-ops/ledger/matcher-inventory-drift-2026-10-03.md).
 *
 * The matcher's `inventory_base` counter only moves on matcher fills; liquidations, ADL scaling,
 * side resets, RebalanceReduce (44), force-close and no-CPI trades leave it stale (13 drifted
 * markets on 2026-10-03). After the upgrade (wrapper 7a3ac04c+ / matcher b5b419da) the wrapper
 * tells the canonical matcher the LP's ADL-EFFECTIVE engine position on every fill and the
 * matcher prices / caps against that, so the true room is `cap ∓ realPosition`.
 *
 * Before the upgrade the on-chain matcher still enforces the stale counter, so the app must not
 * offer more than it will fill, and must not offer the "bypass" room that would push the LP past
 * its configured cap either. Hence:
 *
 *   pre-upgrade (or unknown):  room = min(room(counter), room(real))   [both when known]
 *   post-upgrade (detected):   room = room(real)                       [counter only as fallback]
 *
 * `room(x)` is `remainingSideCapacityQ(x, maxInventoryAbs, side)` (lib/marketCapacity.ts).
 */
import { remainingSideCapacityQ, type TradeSide } from "@/lib/marketCapacity";
import { effectiveLeg, type EffectiveAssetSides } from "./effective-quantity";
import * as C from "./constants";

const dv = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u128 = (d: Uint8Array, o: number) => {
  const v = dv(d);
  return (v.getBigUint64(o + 8, true) << 64n) | v.getBigUint64(o, true);
};
const i128 = (d: Uint8Array, o: number) => {
  const u = u128(d, o);
  return u >= 1n << 127n ? u - (1n << 128n) : u;
};

/**
 * Port of wrapper 7a3ac04c `raw_and_effective_signed_position_for_asset_view(..).1` on raw portfolio
 * bytes: the FIRST active leg for `(assetIndex, marketId)`, ADL-effective and signed (+ long, − short);
 * a prior-reset obligation owns 0; no leg = 0. `null` = the engine would call the leg InvalidLeg,
 * or the account is too short (callers then fall back to the counter).
 */
export function lpEffectiveSignedQ(
  portfolio: Uint8Array,
  asset: EffectiveAssetSides,
  assetIndex: number,
  marketId: bigint,
): bigint | null {
  if (portfolio.length < C.PF_LEGS + C.PF_MAX_LEGS * C.PF_LEG_LEN) return null;
  const v = dv(portfolio);
  for (let s = 0; s < C.PF_MAX_LEGS; s++) {
    const l = C.PF_LEGS + s * C.PF_LEG_LEN;
    if (portfolio[l + C.LEG_ACTIVE] !== 1) continue;
    if (v.getUint32(l + C.LEG_ASSET_INDEX, true) !== assetIndex) continue;
    if (v.getBigUint64(l + C.LEG_MARKET_ID, true) !== marketId) continue;
    const eff = effectiveLeg(asset, {
      active: true,
      side: portfolio[l + C.LEG_SIDE],
      basisPosQ: i128(portfolio, l + C.LEG_BASIS_POS_Q),
      aBasis: u128(portfolio, l + C.LEG_A_BASIS),
      epochSnap: v.getBigUint64(l + C.LEG_EPOCH_SNAP, true),
    });
    return eff.kind === "invalid" ? null : eff.signedQ;
  }
  return 0n;
}

export interface LpInventoryInputs {
  /** The matcher ctx `inventory_base` (null = unread). */
  counterQ: bigint | null;
  /** `lpEffectiveSignedQ` of the market's LP (null = unread / InvalidLeg). */
  realQ: bigint | null;
  maxInventoryAbs: bigint;
  /** `matcherLpSyncLive` (lib/program-upgrade-detect.ts). */
  syncLive: boolean;
}

/** The LP's room on `side`; null = neither inventory is known (callers then skip the check). */
export function lpInventoryRoomQ(i: LpInventoryInputs, side: TradeSide): bigint | null {
  const room = (x: bigint) => remainingSideCapacityQ(x, i.maxInventoryAbs, side);
  if (i.syncLive) {
    if (i.realQ !== null) return room(i.realQ);
    return i.counterQ !== null ? room(i.counterQ) : null;
  }
  const rooms = [i.counterQ, i.realQ].filter((x): x is bigint => x !== null).map(room);
  if (rooms.length === 0) return null;
  return rooms.reduce((a, b) => (b < a ? b : a));
}

/**
 * The inventory the matcher itself prices and clips from (P2 quote preview, skew indicator):
 * the real position once the sync is live, the stored counter before. Not a min — a quote must
 * reproduce what the program will do.
 */
export function matcherPricingInventoryQ(i: Pick<LpInventoryInputs, "counterQ" | "realQ" | "syncLive">): bigint | null {
  if (i.syncLive && i.realQ !== null) return i.realQ;
  return i.counterQ;
}
