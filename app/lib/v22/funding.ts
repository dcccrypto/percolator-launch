/**
 * v2.2 funding rate, read from the market account (QA FUND-7). The engine does not STORE a rate: every accrual takes
 * `funding_rate_e9` from the wrapper, which derives it from market state (wrapper v16_program.rs
 * `permissionless_funding_rate_e9_view`, `policy_v16::premium_funding_rate_e9`, `vault_lp_v18::skew_funding_rate_e9` /
 * `combine_funding_rate_e9`). This module mirrors that derivation for the asset's CURRENT state:
 *
 *   rate_e9 = clamp( premium + skew , +-max_abs_funding_e9_per_slot )
 *   premium = sign(mark - index) * min( |mark - index| * 1e9 / index , max_abs )      mark = funding_mark_e6, index = effective price
 *   skew    = vault LP bound && slope != 0:  (lp_net < 0 ? + : -) min( slope * min(|lp_net|, oi_side) / oi_side , skew_max )
 *             oi_side = max(oi_eff_long, oi_eff_short)
 *
 * SIGN (engine v16.rs kernel_funding_index_deltas): rate > 0 means LONGS PAY SHORTS; rate < 0 shorts pay longs. The unit is
 * e9 of notional PER SLOT; it accrues only while both sides hold exposure and the oracle mode is price-managed
 * (hybrid / ewma / auth mark), otherwise the applied rate is 0.
 *
 * OFFSETS (derived from the sources, then pinned by a real devnet account in __tests__/lib/v22/funding.test.ts):
 *   wrapper slot (slotOff(i)): profile at +0 (AssetOracleProfileV16, repr(C), 512 B): oracle_mode u8 @0, mark_ewma_e6 u64 @168,
 *     mark_ewma_last_slot u64 @176, funding_mark_e6 u64 @432 (creator_fee 400, maintenance_fee_checkpoint_slot 408,
 *     previous_rate u128 @416 [16-aligned], then funding_mark_e6 432 / pending_e6 440 / pending_slot 448);
 *     vault-LP record at +896 (AssetVaultLpV18): lp_net_q i128 @32, skew_slope_e9 u64 @72, skew_max_e9 u64 @80, flags u8 @90.
 *   engine slot (engineOff(i)): asset effective_price u64 @25, fund_px_last u64 @33, slot_last u64 @41, oi_eff_long_q u128 @289,
 *     oi_eff_short_q u128 @305. max_abs_funding_e9_per_slot: lib/v17-engine-config.ts readV17MaxAbsFunding.
 * Not modelled: a PENDING funding mark (funding_mark_pending_*): the next crank may re-derive the index; this is the rate the
 * current state implies. A SDK decoder (percolator-sdk feat/v22-sdk) replaces this when it lands in the app's pin.
 */
import { resolveMarketGeometry } from "@/lib/v22/sdk";
import { readV17MaxAbsFunding } from "@/lib/v17-engine-config";

export const FUNDING_DEN_E9 = 1_000_000_000n;
/** 8 hours at ~400 ms per slot. */
export const SLOTS_PER_8H = 72_000;

const PROFILE = { oracleMode: 0, markEwmaE6: 168, markEwmaLastSlot: 176, fundingMarkE6: 432 } as const;
const VAULT_LP = { lpNetQ: 32, skewSlopeE9: 72, skewMaxE9: 80, flags: 90 } as const;
const ASSET = { effectivePrice: 25, slotLast: 41, oiEffLongQ: 289, oiEffShortQ: 305 } as const;
const WRAPPER_VAULT_LP_OFF = 896;
const ORACLE_PRICE_MANAGED = new Set([1, 2, 3]); // HYBRID_AFTER_HOURS, EWMA_MARK, AUTH_MARK
const VAULT_LP_BOUND = 1;

export interface FundingViewV22 {
  assetIndex: number;
  /** Signed e9-of-notional per slot. > 0: longs pay shorts. */
  rateE9PerSlot: bigint;
  premiumE9: bigint;
  skewE9: bigint;
  maxAbsE9: bigint;
  /** Both sides hold exposure (the engine accrues funding only then). */
  bothSides: boolean;
  /** The oracle mode is price-managed (otherwise the wrapper applies 0). */
  managed: boolean;
  /** Signed percent of notional per 8 h at the current rate. */
  pctPer8h: number;
  direction: "longs-pay-shorts" | "shorts-pay-longs" | "none";
}

const u64 = (dv: DataView, o: number): bigint => dv.getBigUint64(o, true);
const u128 = (dv: DataView, o: number): bigint => (dv.getBigUint64(o + 8, true) << 64n) | dv.getBigUint64(o, true);
const i128 = (dv: DataView, o: number): bigint => BigInt.asIntN(128, u128(dv, o));
const absB = (n: bigint): bigint => (n < 0n ? -n : n);

export function decodeFundingV22(data: Uint8Array, assetIndex = 0): FundingViewV22 | null {
  let g;
  try {
    g = resolveMarketGeometry(data, { parser: "decodeFundingV22", strictLength: false });
  } catch {
    return null;
  }
  if (g.layout.version < 19 || assetIndex < 0 || assetIndex >= g.slotCount) return null;
  const maxAbs = readV17MaxAbsFunding(data);
  if (maxAbs === null) return null;
  const w = g.slotOff(assetIndex);
  const e = g.engineOff(assetIndex);
  if (e + ASSET.oiEffShortQ + 16 > data.length || w + WRAPPER_VAULT_LP_OFF + 96 > data.length) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const managed = ORACLE_PRICE_MANAGED.has(data[w + PROFILE.oracleMode]);
  const effective = u64(dv, e + ASSET.effectivePrice);
  const assetSlot = u64(dv, e + ASSET.slotLast);
  const oiLong = u128(dv, e + ASSET.oiEffLongQ);
  const oiShort = u128(dv, e + ASSET.oiEffShortQ);
  const bothSides = oiLong !== 0n && oiShort !== 0n;

  let premium = 0n;
  let skew = 0n;
  if (managed && maxAbs !== 0n) {
    const mark = u64(dv, w + PROFILE.fundingMarkE6);
    const ewma = u64(dv, w + PROFILE.markEwmaE6);
    const ewmaSlot = u64(dv, w + PROFILE.markEwmaLastSlot);
    // wrapper: funding_mark_e6 if set; else the EWMA mark once the asset has caught up to it; else 0.
    const active = mark !== 0n ? mark : ewmaSlot <= assetSlot ? ewma : 0n;
    if (active !== 0n && effective !== 0n && active !== effective) {
      const diff = active > effective ? active - effective : effective - active;
      const mag = (diff * FUNDING_DEN_E9) / effective;
      const bounded = mag < maxAbs ? mag : maxAbs;
      premium = active > effective ? bounded : -bounded;
    }
    const v = w + WRAPPER_VAULT_LP_OFF;
    const slope = u64(dv, v + VAULT_LP.skewSlopeE9);
    const skewMax = u64(dv, v + VAULT_LP.skewMaxE9);
    const bound = (data[v + VAULT_LP.flags] & VAULT_LP_BOUND) !== 0;
    const lpNet = i128(dv, v + VAULT_LP.lpNetQ);
    const oiSide = oiLong > oiShort ? oiLong : oiShort;
    if (bound && slope !== 0n && skewMax !== 0n && lpNet !== 0n && oiSide !== 0n) {
      const share = absB(lpNet) > oiSide ? oiSide : absB(lpNet);
      const m = (slope * share) / oiSide;
      const capped = m > skewMax ? skewMax : m;
      skew = lpNet < 0n ? capped : -capped; // LP net short = traders net long = longs pay
    }
  }
  let rate = premium + skew;
  if (rate > maxAbs) rate = maxAbs;
  if (rate < -maxAbs) rate = -maxAbs;
  // The engine accrues funding only with exposure on both sides: otherwise nobody pays.
  const applied = bothSides ? rate : 0n;
  return {
    assetIndex,
    rateE9PerSlot: rate,
    premiumE9: premium,
    skewE9: skew,
    maxAbsE9: maxAbs,
    bothSides,
    managed,
    pctPer8h: (Number(applied) * SLOTS_PER_8H) / Number(FUNDING_DEN_E9) * 100,
    direction: applied > 0n ? "longs-pay-shorts" : applied < 0n ? "shorts-pay-longs" : "none",
  };
}

/** The one-line "who pays whom" for the header and the ticket. */
export function fundingDirectionText(d: FundingViewV22["direction"]): string {
  return d === "longs-pay-shorts" ? "Longs pay shorts" : d === "shorts-pay-longs" ? "Shorts pay longs" : "No funding paid";
}
