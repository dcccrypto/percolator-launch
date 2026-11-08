/**
 * Vote outcome rule and exact formatting. Pure, BigInt only.
 *
 * Balance-weighted simple majority, no quorum. Weekly fee claims wins only on
 * a strict majority of voted balance; a tie or zero votes is buy-and-burn.
 * (The database tally applies the same rule; this mirror is what the API and
 * tests use to double-check it.)
 */
import { DEFAULT_CHOICE, type VoteChoice } from "./vote-message";

export function decideWinner(weeklyFeeClaimsRaw: bigint, buyAndBurnRaw: bigint): VoteChoice {
  if (weeklyFeeClaimsRaw < 0n || buyAndBurnRaw < 0n) throw new RangeError("negative tally");
  return weeklyFeeClaimsRaw > buyAndBurnRaw ? "weekly-fee-claims" : DEFAULT_CHOICE;
}

/** Exact decimal string of `raw` base units with `decimals` places, trailing zeros trimmed. */
export function formatUnits(raw: bigint, decimals: number): string {
  if (raw < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new RangeError("bad units");
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
}

/** Share of `part` in `total` as a percentage string with 2 decimals, rounded down. */
export function sharePercent(part: bigint, total: bigint): string {
  if (total <= 0n) return "0.00";
  const bp = (part * 100n * 100n) / total; // basis points
  return `${bp / 100n}.${(bp % 100n).toString().padStart(2, "0")}`;
}
