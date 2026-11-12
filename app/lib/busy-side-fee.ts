/**
 * Owner decision 2026-11-12 (item 3): a growth market's busy side charges an extra utilisation ("busy-side") fee on an OPEN. It is its own
 * line before the trade and is never part of the position's Entry (lib/v22/exec-fill.ts). One definition of the wording for the order
 * ticket and the confirm screen. The fee is INSIDE the total fee estimate ("Fee (est.)") and the Max / balance sizing (#3553): the notice says so.
 */

/** "5.00%" from bps. */
export function busyFeePct(bps: bigint): string {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

/** The value of the separate line: "5.00% · 60.25 USDC". `amount` is already formatted with its symbol. */
export function busyFeeValue(bps: bigint, amount: string): string {
  return `${busyFeePct(bps)} · ${amount}`;
}

export const BUSY_FEE_LABEL = "Busy-side fee";

/** The notice shown with the line. `fixed1x`: Max forced the 1x leverage, which is the case where it matters most. */
export function busyFeeNotice(bps: bigint, amount: string, fixed1x: boolean): string {
  const fee = `a ${busyFeePct(bps)} busy-side fee (${amount})`;
  return fixed1x
    ? `This side is busy. Leverage is fixed at 1x and ${fee} is included in the trading fee above. It is not part of your entry price.`
    : `This side is busy. ${fee[0].toUpperCase()}${fee.slice(1)} is included in the trading fee above. It is not part of your entry price.`;
}
