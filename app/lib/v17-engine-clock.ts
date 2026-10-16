/**
 * v17/v18 market clocks — the two slot counters the trade UI gates on, and
 * which on-chain field each one actually lives in.
 *
 * Verified against the deployed wrapper (percolator-prog v18.2 6377376a,
 * engine 35ddd692) and live devnet bytes (see __tests__/fixtures/*.freshness.*):
 *
 * 1. ORACLE PUSH clock — "is the keeper still delivering prices?"
 *    `PushAuthMark` (oracle_mode 3, AUTH_MARK) and `PushEwmaMark` (mode 2,
 *    EWMA_MARK) write `last_good_oracle_slot = authenticated_slot` on EVERY
 *    accepted push, but only write `mark_ewma_last_slot` (and `mark_ewma_e6`)
 *    when the pushed/EWMA price VALUE differs from the stored one
 *    (`if mark_e6 != profile.mark_ewma_e6 { … mark_ewma_last_slot = … }`).
 *    A held or flat price therefore leaves `mark_ewma_last_slot` frozen while
 *    pushes keep landing — live, TRUMP read mark_ewma_last_slot 15,615 slots
 *    (~1.7h) behind the tip with last_good_oracle_slot 0 slots behind.
 *    For those modes the push clock is `last_good_oracle_slot`.
 *    Other modes keep `mark_ewma_last_slot` (manual mode is gated on
 *    `authorityTimestamp` upstream of this, and hybrid mode's
 *    `last_good_oracle_slot` only advances on an external-feed read inside a
 *    crank, which is a different signal — left unchanged here on purpose).
 *
 * 2. ENGINE ACCRUAL clock — "can a trade/close still accrue this market?"
 *    `AssetStateV16Account.slot_last` advances only when the market is
 *    ACCRUED (crank / trade), never on a bare price push. One accrual covers at
 *    most `max_accrual_dt_slots` (V16ConfigAccount) — a gap wider than that
 *    leaves `slot_last < now` after the instruction (`bounded_market_catchup_
 *    only`), and trade/close/withdraw paths reject a lagging asset
 *    (`asset_local_loss_stale_view` → EngineLockActive). So "crank behind" is
 *    `chainSlot - slot_last` measured against `max_accrual_dt_slots`.
 *    `last_good_oracle_slot` is NOT this clock: in AUTH_MARK only a push
 *    advances it, so it reads fresh while the crank is dead, and it says
 *    nothing about accrual.
 */
import { marketGeometry, isUnsupportedLayout } from "@/lib/v22/layout";
import { engineConfigOff } from "@/lib/v17-engine-config";

/** Wrapper `oracle_mode` bytes (percolator-prog `constants::ORACLE_MODE_*`). */
export const ORACLE_MODE_MANUAL = 0;
export const ORACLE_MODE_HYBRID_AFTER_HOURS = 1;
export const ORACLE_MODE_EWMA_MARK = 2;
export const ORACLE_MODE_AUTH_MARK = 3;

/**
 * `AssetStateV16Account.slot_last`, relative to the start of the engine asset
 * slot: market_id(8) + retired_slot(8) + lifecycle(1) +
 * raw_oracle_target_price(8) + effective_price(8) + fund_px_last(8) = 41
 * (packed Pod struct, no padding).
 */
const ASSET_STATE_SLOT_LAST_REL = 41;

/**
 * `V16ConfigAccount.max_accrual_dt_slots`, relative to the config block —
 * immediately after `min_liquidation_abs` (u128 @ 102..118). See the field
 * table in lib/v17-engine-config.ts.
 */
const CONFIG_MAX_ACCRUAL_DT_SLOTS_REL = 118;

/**
 * Read `AssetStateV16Account.slot_last` for one asset slot.
 *
 * The wrapper's per-asset oracle storage that precedes the engine asset slot
 * is `V17_ASSET_ORACLE_WRAPPER_LEN` bytes — 1024 on v18 (it was 512 on v17).
 * Hardcoding 512 read 41 bytes into the wrapper region on v18, which is zero
 * on live markets, so every consumer saw "never cranked / ~505M slots behind".
 *
 * Returns null when the account is too short or the slot has never been
 * accrued (0) — callers treat that as unknown, not as infinitely stale.
 */
export function readV17AssetSlotLast(data: Uint8Array, assetIndex = 0): bigint | null {
  let engineOff: number;
  try {
    engineOff = marketGeometry(data, "readV17AssetSlotLast").engineOff(assetIndex);
  } catch (e) {
    if (isUnsupportedLayout(e)) return null;
    throw e;
  }
  const off = engineOff + ASSET_STATE_SLOT_LAST_REL;
  if (off + 8 > data.length) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const v = dv.getBigUint64(off, true);
  return v > 0n ? v : null;
}

/** Read the market's `max_accrual_dt_slots` (engine V16ConfigAccount). Null when unreadable or 0. */
export function readV17MaxAccrualDtSlots(data: Uint8Array): bigint | null {
  const cfgOff = engineConfigOff(data);
  if (cfgOff === null) return null;
  const off = cfgOff + CONFIG_MAX_ACCRUAL_DT_SLOTS_REL;
  if (off + 8 > data.length) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const v = dv.getBigUint64(off, true);
  return v > 0n ? v : null;
}

/** Fields of `WrapperConfigV17` the push clock needs (partial so test mocks stay light). */
export interface OraclePushClockFields {
  oracleMode: number;
  markEwmaLastSlot: bigint;
  lastGoodOracleSlot?: bigint;
}

/**
 * The slot of the keeper's last ACCEPTED price push — see (1) above.
 *
 * AUTH_MARK / EWMA_MARK: `max(last_good_oracle_slot, mark_ewma_last_slot)`.
 * On chain the former is always >= the latter for these modes (both are set to
 * the same slot on a value change; only the former on a same-value push), so
 * this is `last_good_oracle_slot`; the max only guards a config that omits it.
 * Fail-closed is preserved: a keeper that stops pushing stops advancing BOTH.
 *
 * Returns 0n when no push has ever landed.
 */
export function oraclePushSlotV17(cfg: OraclePushClockFields): bigint {
  const mark = cfg.markEwmaLastSlot ?? 0n;
  if (cfg.oracleMode === ORACLE_MODE_AUTH_MARK || cfg.oracleMode === ORACLE_MODE_EWMA_MARK) {
    const good = cfg.lastGoodOracleSlot ?? 0n;
    return good > mark ? good : mark;
  }
  return mark;
}
