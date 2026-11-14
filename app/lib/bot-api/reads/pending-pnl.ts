/**
 * The K/F PnL a leg has accrued since its snapshot and the engine has not yet moved into `pnl`.
 *
 * The engine settles a leg (a trade, a crank, a close) with `leg_kf_delta_components_for_settlement_from_targets`
 * (engine release/v22-engine-rem src/v16.rs):
 *
 *     k_delta = floor((|basis_pos_q| x (K_side_now - k_snap) + k_rem_num) / (a_basis x POS_SCALE))
 *     f_delta = floor((|basis_pos_q| x (F_side_now - f_snap) + f_rem_num) / (a_basis x POS_SCALE))
 *     net     = k_delta + f_delta          (signed, + = the leg gained)
 *
 * K accrues on `effective_price` deltas, so `pnl + net` is the leg's result at the engine's effective price, the figure
 * margin and liquidation use. The stored `pnl` alone is only what the last settle booked: a loss K has accrued since is
 * invisible there, which is why a leverage cap fed the stored pnl overstates equity.
 *
 * Two deliberate approximations, both toward the SAFE side (a lower equity, a tighter cap):
 *  - the sub-atom carries `k_rem_num` / `f_rem_num` are not decoded by the portfolio parser; they are in [0, den), so each
 *    floor here is at most 1 atom below the engine's (a gain under-counted, a loss over-counted, by <= 2 atoms in all);
 *  - holding rent (`rent_snap` vs the rent index) and the social-loss share (`b_snap`, `b_rem`) are NOT included. Rent is
 *    charged from capital never below an unsettled loss; the B share is zero unless a deficit was socialised.
 * Pure. null when the engine would not settle the leg against the live indices (an older ADL epoch, a stale leg, a leg
 * ahead of its side's kf epoch, unreadable indices): the caller must refuse to value the account, never guess.
 */
import type { AssetSettleState, RiskLegSnap } from "@/lib/risk-entry";

const POS_SCALE = 1_000_000n;

export interface PendingKf {
  /** K part, atoms (signed, + = gain). */
  k: bigint;
  /** F part, atoms (signed, + = received). */
  f: bigint;
  /** k + f. */
  net: bigint;
}

const floorDiv = (n: bigint, d: bigint): bigint => (n >= 0n ? n / d : -((-n + d - 1n) / d));

export function pendingKfPnl(
  asset: AssetSettleState | null | undefined,
  leg: RiskLegSnap | null | undefined,
  basisQ: bigint,
  aBasis: bigint,
): PendingKf | null {
  if (!asset || !leg || aBasis <= 0n) return null;
  if (basisQ === 0n) return { k: 0n, f: 0n, net: 0n };
  if (leg.stale) return null;
  const long = leg.side === 0;
  if (!long && leg.side !== 1) return null;
  // kf_target_for_leg_from_asset: the live K/F only for a leg on the side's current ADL epoch (else the epoch-start values or InvalidLeg).
  if (leg.epochSnap !== (long ? asset.epochLong : asset.epochShort)) return null;
  // A leg ahead of its side's kf epoch cannot exist on chain: the two reads are out of order.
  if (leg.kfEpochSnap > (long ? asset.kfEpochLong : asset.kfEpochShort)) return null;
  const basisAbs = basisQ < 0n ? -basisQ : basisQ;
  const den = aBasis * POS_SCALE;
  const kNow = long ? asset.kLong : asset.kShort;
  const fNow = long ? asset.fLong : asset.fShort;
  const k = floorDiv(basisAbs * (kNow - leg.kSnap), den);
  const f = floorDiv(basisAbs * (fNow - leg.fSnap), den);
  return { k, f, net: k + f };
}
