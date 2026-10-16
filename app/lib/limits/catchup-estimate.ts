/**
 * v2.2 round i: how long a price catch-up wait will last, from the market account.
 *
 * The engine refuses a risk-increasing fill while the asset's effective price differs from the pushed target, and the
 * effective price walks toward the target by at most `max_price_move_bps_per_slot` per slot (ledger
 * v22-diag-swordcat-21-catchup-2026-10-13.md). A gap of J bps therefore clears in ceil(J / cap) slots, plus up to one
 * keeper sweep (~6 s) before the next accrual. The fixed 2-minute wait budget was shorter than any move above ~5%.
 */
import type { Connection } from "@solana/web3.js";

/** Conservative slot time when none is measured (mainnet nominal; devnet runs ~240 ms, so this over-estimates). */
export const SLOT_MS_DEFAULT = 400;
/** One keeper sweep: the lag the user's own observation crank can create clears in about this long. */
export const KEEPER_SWEEP_MS = 6_000;
/** A gap that clears inside about one sweep: a single silent retry is enough. */
export const SHORT_LAG_MS = 12_000;
export const MIN_WAIT_BUDGET_MS = 120_000;
export const MAX_WAIT_BUDGET_MS = 600_000;

export interface CatchUpEstimate {
  gapBps: number;
  slots: number;
  /** Slots at `slotMs` plus one keeper sweep; 0 when there is no gap. */
  ms: number;
}

/** null when the numbers do not allow an estimate (no cap / no price). */
export function catchUpEstimate(p: { effectiveE6: bigint; targetE6: bigint; capBpsPerSlot: bigint | number; slotMs?: number }): CatchUpEstimate | null {
  const cap = p.capBpsPerSlot === undefined || p.capBpsPerSlot === null ? 0n : BigInt(p.capBpsPerSlot);
  if (cap <= 0n || p.effectiveE6 <= 0n || p.targetE6 <= 0n) return null;
  const diff = p.effectiveE6 > p.targetE6 ? p.effectiveE6 - p.targetE6 : p.targetE6 - p.effectiveE6;
  if (diff === 0n) return { gapBps: 0, slots: 0, ms: 0 };
  const gapBps = (diff * 10_000n + p.effectiveE6 - 1n) / p.effectiveE6; // ceil
  const slots = (gapBps + cap - 1n) / cap; // ceil
  const slotMs = p.slotMs && p.slotMs > 0 ? p.slotMs : SLOT_MS_DEFAULT;
  return { gapBps: Number(gapBps), slots: Number(slots), ms: Math.round(Number(slots) * slotMs) + KEEPER_SWEEP_MS };
}

/** Wait budget: max(2 min, estimate x 1.5), at most 10 min. No estimate = the old 2 minutes. */
export function catchUpBudgetMs(estimateMs: number | null | undefined): number {
  if (estimateMs === null || estimateMs === undefined || !Number.isFinite(estimateMs) || estimateMs <= 0) return MIN_WAIT_BUDGET_MS;
  return Math.min(MAX_WAIT_BUDGET_MS, Math.max(MIN_WAIT_BUDGET_MS, Math.ceil(estimateMs * 1.5)));
}

/** True when the estimate does not fit the budget cap (the copy then says it can take several minutes). */
export function exceedsBudgetCap(estimateMs: number): boolean {
  return estimateMs * 1.5 > MAX_WAIT_BUDGET_MS;
}

/** "a few seconds", "about 40 seconds", "about 3 minutes", "about 45 minutes", "about 2 hours". Seconds only below a minute. */
export function waitWords(ms: number): string {
  const s = Math.ceil(ms / 1000);
  if (s <= 10) return "a few seconds";
  if (s < 60) return `about ${Math.ceil(s / 5) * 5} seconds`;
  const m = Math.ceil(s / 60);
  if (m >= 100) return `about ${Math.round(m / 60)} hours`;
  if (m >= 55) return "about an hour";
  return m <= 1 ? "about a minute" : `about ${m} minutes`;
}

/** The wait for the "available in …" sentence: no seconds promise at all ("under a minute" below one minute). */
export function availableInWords(ms: number): string {
  return Math.ceil(ms / 1000) < 60 ? "under a minute" : waitWords(ms);
}

export const CATCHUP_COPY = {
  title: "Catching up",
  line: (ms: number) => `Price is catching up — ${waitWords(ms)}. Goes through automatically.`,
  /** Beyond what the app waits for on its own: the honest time, and that it will not go through by itself. */
  long: (ms: number) => `Price is catching up after a big move — ${waitWords(ms)}. You can stop and try again later.`,
} as const;

/** The line for the current estimate (null = no estimate: the generic wait copy stays). */
export function catchUpLine(estimateMs: number | null | undefined): string | null {
  if (estimateMs === null || estimateMs === undefined || estimateMs <= 0) return null;
  return exceedsBudgetCap(estimateMs) ? CATCHUP_COPY.long(estimateMs) : CATCHUP_COPY.line(estimateMs);
}

/** What the catch-up is holding back, for the one-sentence form. */
export type CatchUpWhat = "close" | "open" | "any";

const AVAILABLE: Record<Exclude<CatchUpWhat, "any">, string> = { close: "Closing is available", open: "New positions are available" };
const WHEN_GENERIC: Record<Exclude<CatchUpWhat, "any">, string> = { close: "Closing reopens", open: "New positions reopen" };

/**
 * Honest, calm copy for a refusal caused by the price still catching up (the catch-up cap: errors 21 / 104). The wait is computed from
 * the market (gap between the target and effective price over the per-slot cap, see {@link catchUpEstimate}); with no estimate it says
 * only that this usually takes a few minutes. It never promises seconds.
 */
export function catchUpAvailableLine(estimateMs: number | null | undefined, what: CatchUpWhat): string {
  const lead = "The price is still catching up after a big move.";
  const known = estimateMs !== null && estimateMs !== undefined && Number.isFinite(estimateMs) && estimateMs > 0;
  if (what === "any") return known ? `${lead} Try again in ${availableInWords(estimateMs)}.` : `${lead} This usually takes a few minutes; try again then.`;
  if (!known) return `${lead} ${WHEN_GENERIC[what]} when it has; this usually takes a few minutes.`;
  return `${lead} ${AVAILABLE[what]} in ${availableInWords(estimateMs)}.`;
}

/** Measured slot time (ms) from the RPC's recent performance samples; SLOT_MS_DEFAULT on any failure. Cached for 5 minutes. */
let slotCache: { ms: number; at: number } | null = null;
export async function measureSlotMs(connection: Pick<Connection, "getRecentPerformanceSamples">, now: number = Date.now()): Promise<number> {
  if (slotCache && now - slotCache.at < 300_000) return slotCache.ms;
  try {
    const s = await Promise.race([
      connection.getRecentPerformanceSamples(2),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 1_500)),
    ]);
    const slots = s.reduce((a, x) => a + x.numSlots, 0);
    const secs = s.reduce((a, x) => a + x.samplePeriodSecs, 0);
    if (slots > 0 && secs > 0) {
      const ms = Math.min(SLOT_MS_DEFAULT, Math.max(200, (secs * 1000) / slots));
      slotCache = { ms, at: now };
      return ms;
    }
  } catch { /* fall through */ }
  return SLOT_MS_DEFAULT;
}
export function __resetSlotCacheForTest(): void { slotCache = null; }

/**
 * A post-signature "catching up" refusal (the order passed the pre-send simulation, the wallet signed, then the send hit 21)
 * is retried ONCE after ~7 s when the gap is tiny, before any message. `onWaiting(true)` runs BEFORE the sleep so the ticket
 * already says why when the wallet reopens. Anything else, a second refusal, a stop, or a long gap: the error is rethrown.
 */
export const SILENT_RETRY_DELAY_MS = 7_000;
export async function retryOnceAfterShortLag<T>(
  run: () => Promise<T>,
  o: {
    isLagRefusal: (e: unknown) => boolean;
    estimateMs: () => number | null;
    onWaiting?: (waiting: boolean) => void;
    sleep?: (ms: number) => Promise<void>;
    aborted?: () => boolean;
  },
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const est = o.estimateMs();
    if (!o.isLagRefusal(e) || o.aborted?.() || (est !== null && est > SHORT_LAG_MS)) throw e;
    o.onWaiting?.(true);
    await (o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(SILENT_RETRY_DELAY_MS);
    o.onWaiting?.(false);
    if (o.aborted?.()) throw e;
    return run();
  }
}
