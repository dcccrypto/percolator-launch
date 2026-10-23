/**
 * v2.2 QA U-2 follow-up: a 98 (the signed fee cap does not cover the busy-side fee) is retried ONCE, silently, at a raised cap
 * (lib/limits/trade-fee-resolve.ts sendWithUtilFeeRetry). The user did not sign twice, so once the order lands we say the cap
 * was raised and by how much. Same hand-off as lib/limits/fill-check.ts: the hook records by signature, the ticket takes it.
 */
export interface FeeRaise {
  /** The fee cap (bps) the first attempt signed. */
  fromBps: bigint;
  /** The cap (bps) the retry signed. */
  toBps: bigint;
}

const raises = new Map<string, FeeRaise>();

/** Bounded like the fill results: oldest dropped past 32. A retry that did not raise the cap records nothing. */
export function recordFeeRaise(sig: string, r: FeeRaise | null): void {
  if (!r || r.toBps <= r.fromBps) return;
  raises.set(sig, r);
  while (raises.size > 32) {
    const first = raises.keys().next().value;
    if (first === undefined) break;
    raises.delete(first);
  }
}

export function takeFeeRaise(sig: string | null | undefined): FeeRaise | null {
  if (!sig) return null;
  const r = raises.get(sig) ?? null;
  raises.delete(sig);
  return r;
}

const pct = (bps: bigint): string => `${(Number(bps) / 100).toFixed(2)}%`;

/** One calm line: what changed, by how much, and that only the fee actually charged is paid. */
export function feeRaiseCopy(r: FeeRaise): string {
  return `The fee limit on this order was raised by ${pct(r.toBps - r.fromBps)} (to ${pct(r.toBps)}) so it could go through on a busy side. You pay only the fee actually charged.`;
}
