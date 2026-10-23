/**
 * #3534: the entry the RISK math (liquidation price, margin cushion / tier, margin health) uses, kept apart from
 * the entry the position is DISPLAYED with.
 *
 * Why. A v17+ settle on an open leg realises the K/F move since the leg's snapshot into `pnl`, re-snaps `k_snap`, and
 * for a solvent loser moves that loss out of `capital` (pushing `pnl` toward 0). The device a position was opened
 * from values it from its cached fill price (lib/entry-price.ts) and the risk math is `capital + q x (mark - entry)`,
 * so once a settle has happened the settled loss is in BOTH terms: counted twice. The liquidation price, cushion,
 * tier, margin health and the site-wide warning all read worse than the account is. Other devices back-solve the
 * entry from `pnl`, which is consistent.
 *
 * Fix. When a leg has NOTHING pending against the asset's live indices, the engine's equity at a price P is exactly
 *   capital + pnl + q_eff x (P - effective_price)
 * because K accrues on `effective_price` deltas (engine v16.rs, `price_delta = effective_price - old.effective_price`;
 * NOT `fund_px_last`, which zero-move funding may leave behind). The risk entry is then the back-solve
 *   riskEntry = effective_price - pnl / q_eff
 * and `capital + q x (mark - riskEntry)` is the engine's equity whether or not a settle happened. "Nothing pending" is
 * checked field by field, every one the engine's own settle compares (engine release/v22-engine-rem 3ce4cbd1):
 *   - `epoch_snap == epoch_side` (kf_target_for_leg_from_asset: else the epoch-start K/F, or InvalidLeg)
 *   - `kf_epoch_snap == kf_epoch_side` (leg_kf_epoch_is_current)
 *   - `k_snap == K_side`, `f_snap == F_side` (leg_kf_delta_components_for_settlement_from_asset: delta 0)
 *   - `b_epoch_snap == epoch_side`, `b_snap == B_side` (b_target_for_leg: no social-loss share pending)
 *   - v2.2: `rent_snap == rent_index_side` (settle_leg_rent_not_atomic returns 0)
 *   - the leg is not `stale` / `b_stale`.
 * `pnl` is ONE value per portfolio, so this only applies to a portfolio with a single active leg. Anything else, or
 * any read failure, returns null and the caller keeps today's entry, which errs toward "too risky", never "too safe".
 * The per-leg K/F remainders of v2.2 (`k_rem_num`, `f_rem_num`) are sub-atom carries and do not move this.
 *
 * Offsets. Within `AssetStateV16Account` (repr(C), no padding; identical field order on the v18 engine c141d47f and on
 * the v2.2 engine release/v22-engine-rem): a 49 B header (market_id 0, retired_slot 8, lifecycle 16,
 * raw_oracle_target_price 17, effective_price 25, fund_px_last 33, slot_last 41), then a_long 49, a_short 65,
 * k_long 81, k_short 97, f_long_num 113, f_short_num 129 (i128), kf_epoch_long 145, kf_epoch_short 153 (u64),
 * k/f epoch starts 161..224, b_long_num 225, b_short_num 241 (u128), b epoch starts 257/273, oi_eff_long_q 289 (the
 * cross-check lib/v17-adl.ts and lib/limits/constants.ts already pin), ... epoch_long 497, epoch_short 505. v2.2 rent
 * indices come from the layout table (`bandRent.assetState.rentIndexLongNum` 579 / `rentIndexShortNum` 595).
 */
import { marketGeometry } from "@/lib/v22/layout";
import { sanitizePriceE6 } from "@/lib/oraclePrice";

const REL = {
  effectivePrice: 25,
  kLong: 81,
  kShort: 97,
  fLong: 113,
  fShort: 129,
  kfEpochLong: 145,
  kfEpochShort: 153,
  bLong: 225,
  bShort: 241,
  epochLong: 497,
  epochShort: 505,
} as const;

/** The per-side indices a leg is settled against, for one asset. */
export interface AssetSettleState {
  /** The price K last accrued to (`effective_price`), e6. */
  effectivePriceE6: bigint;
  kLong: bigint;
  kShort: bigint;
  fLong: bigint;
  fShort: bigint;
  kfEpochLong: bigint;
  kfEpochShort: bigint;
  bLong: bigint;
  bShort: bigint;
  epochLong: bigint;
  epochShort: bigint;
  /** v2.2 only (absent on a layout with no holding rent). */
  rentIndexLong?: bigint;
  rentIndexShort?: bigint;
}

/** The leg fields the "nothing pending" check reads (a structural subset of the decoded portfolio leg). */
export interface RiskLegSnap {
  /** 0 = long, 1 = short. */
  side: number;
  kSnap: bigint;
  fSnap: bigint;
  kfEpochSnap: bigint;
  epochSnap: bigint;
  bSnap: bigint;
  bEpochSnap: bigint;
  stale: boolean;
  bStale: boolean;
  /** v2.2 only: holding-rent index snapshot (absent on v2.1 legs). */
  rentSnap?: bigint;
}

const u64 = (d: Uint8Array, o: number): bigint => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
function u128(d: Uint8Array, o: number): bigint {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return v.getBigUint64(o, true) | (v.getBigUint64(o + 8, true) << 64n);
}
function i128(d: Uint8Array, o: number): bigint {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return v.getBigUint64(o, true) | (v.getBigInt64(o + 8, true) << 64n);
}

/** Read asset `assetIndex`'s settle indices from a wrapper market account; null on any doubt. */
export function parseAssetSettleState(slabData: Uint8Array, assetIndex = 0): AssetSettleState | null {
  try {
    const g = marketGeometry(slabData, "parseAssetSettleState");
    if (!Number.isInteger(assetIndex) || assetIndex < 0 || assetIndex >= g.slotCount) return null;
    const e = g.engineOff(assetIndex);
    const rent = g.layout.bandRent?.assetState ?? null;
    const end = Math.max(e + REL.epochShort + 8, rent ? e + rent.rentIndexShortNum + 16 : 0);
    if (end > slabData.length) return null;
    const s: AssetSettleState = {
      effectivePriceE6: u64(slabData, e + REL.effectivePrice),
      kLong: i128(slabData, e + REL.kLong),
      kShort: i128(slabData, e + REL.kShort),
      fLong: i128(slabData, e + REL.fLong),
      fShort: i128(slabData, e + REL.fShort),
      kfEpochLong: u64(slabData, e + REL.kfEpochLong),
      kfEpochShort: u64(slabData, e + REL.kfEpochShort),
      bLong: u128(slabData, e + REL.bLong),
      bShort: u128(slabData, e + REL.bShort),
      epochLong: u64(slabData, e + REL.epochLong),
      epochShort: u64(slabData, e + REL.epochShort),
    };
    if (rent) {
      s.rentIndexLong = u128(slabData, e + rent.rentIndexLongNum);
      s.rentIndexShort = u128(slabData, e + rent.rentIndexShortNum);
    }
    return s;
  } catch {
    return null; // unknown VERSION (isUnsupportedLayout) or a short buffer: today's entry
  }
}

/**
 * The price a fully settled single leg's `pnl` is anchored at (the asset's `effective_price`), or null when anything
 * could still be pending (see the file header). `activeLegCount` must be the portfolio's number of active legs.
 */
export function settledRiskAnchorE6(
  asset: AssetSettleState | null | undefined,
  leg: RiskLegSnap | null | undefined,
  activeLegCount: number | null | undefined,
): bigint | null {
  if (!asset || !leg || activeLegCount !== 1) return null;
  if (leg.stale || leg.bStale) return null;
  const long = leg.side === 0;
  if (!long && leg.side !== 1) return null;
  const epoch = long ? asset.epochLong : asset.epochShort;
  if (leg.epochSnap !== epoch || leg.bEpochSnap !== epoch) return null;
  if (leg.kfEpochSnap !== (long ? asset.kfEpochLong : asset.kfEpochShort)) return null;
  if (leg.kSnap !== (long ? asset.kLong : asset.kShort)) return null;
  if (leg.fSnap !== (long ? asset.fLong : asset.fShort)) return null;
  if (leg.bSnap !== (long ? asset.bLong : asset.bShort)) return null;
  const rentIndex = long ? asset.rentIndexLong : asset.rentIndexShort;
  if (leg.rentSnap !== undefined || rentIndex !== undefined) {
    // A leg that carries a rent snapshot must match a readable index (and vice versa): else rent may be due.
    if (leg.rentSnap === undefined || rentIndex === undefined || leg.rentSnap !== rentIndex) return null;
  }
  const p = sanitizePriceE6(asset.effectivePriceE6);
  return p > 0n ? p : null;
}

/**
 * The risk entry for a settled leg: `anchor - pnl / q_eff` (long) / `anchor + pnl / |q_eff|` (short), so that
 * `capital + q x (P - riskEntry) = capital + pnl + q x (P - anchor)`, the engine's equity. The division rounds toward
 * the riskier entry (a long's entry up, a short's down), so equity is never overstated by the rounding. null when it
 * would not be a positive price.
 */
export function riskEntryFromSettled(effectiveSize: bigint, pnl: bigint, anchorE6: bigint): bigint | null {
  if (effectiveSize === 0n || anchorE6 <= 0n) return null;
  const abs = effectiveSize < 0n ? -effectiveSize : effectiveSize;
  const n = pnl * 1_000_000n;
  // floor(n / abs) for a signed numerator.
  const floor = n >= 0n ? n / abs : -((-n + abs - 1n) / abs);
  // long: entry = anchor - pnl/q; a higher entry is riskier, so subtract the floor.
  // short: entry = anchor + pnl/|q|; a lower entry is riskier, so add the floor too.
  const entry = effectiveSize > 0n ? anchorE6 - floor : anchorE6 + floor;
  return entry > 0n ? entry : null;
}

/**
 * The non-SDK fields the app's portfolio -> Account mappers attach (lib/userAccountScan.ts portfolioV17ToAccount,
 * hooks/usePortfolio.ts), so every risk surface can reach the leg snapshots from the Account it already holds.
 */
export interface RiskLegCarrier {
  riskLeg?: RiskLegSnap | null;
  activeLegCount?: number | null;
}

/** The first active leg (the one `positionSize` is read from) and the number of active legs. */
export function riskLegFields(legs: readonly (RiskLegSnap & { active: boolean })[]): { riskLeg: RiskLegSnap | null; activeLegCount: number } {
  const active = legs.filter((l) => l.active);
  const l = active[0];
  const riskLeg: RiskLegSnap | null = l
    ? { side: l.side, kSnap: l.kSnap, fSnap: l.fSnap, kfEpochSnap: l.kfEpochSnap, epochSnap: l.epochSnap, bSnap: l.bSnap,
        bEpochSnap: l.bEpochSnap, stale: l.stale, bStale: l.bStale, ...(l.rentSnap !== undefined ? { rentSnap: l.rentSnap } : {}) }
    : null;
  return { riskLeg, activeLegCount: active.length };
}

/** Read the carrier fields off any account-shaped value (absent on legacy / hand-built accounts). */
export function riskLegOf(account: unknown): RiskLegCarrier {
  if (account === null || typeof account !== "object") return {};
  const a = account as RiskLegCarrier;
  return { riskLeg: a.riskLeg ?? null, activeLegCount: a.activeLegCount ?? null };
}
