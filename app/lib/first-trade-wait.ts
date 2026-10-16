/**
 * v2.2 QA RT5b (U-1 follow-up): the deposit-and-trade path waits for the market like the plain trade path does.
 *
 * On a market whose price is still catching up to the latest oracle price (effective price != target; seen on the
 * band market swordcat for 30 s and more while the price keeps moving) the program refuses every new position with 21,
 * whatever is cranked in the same transaction. The plain trade path already waits through that (sendTxWaiting, up to
 * the ticket's budget, "goes through automatically"). The deposit-and-trade path re-checked three times in 4.5 s and
 * then failed with "Nothing was sent. Try again", which is what a user whose balance was swept after a close always hit.
 *
 * `maxWaitMs` undefined keeps the old behaviour exactly (`legacyAttempts` re-checks, the refusal rethrown). With a
 * budget: re-simulate on sendTxWaiting's delays until the budget is spent (WaitExhaustedError), the user stops
 * (WaitStoppedError) or `shouldWait` says the refusal will not clear. The wallet never opens while waiting.
 */
import { WAIT_DELAYS_MS, WaitExhaustedError, WaitStoppedError, type SimulationRefusal } from "@/lib/tx";

export interface PresignWaitOptions {
  /** Is this error a pre-sign refusal worth waiting for (19 / 21 from the wrapper)? */
  waitable: (e: unknown) => boolean;
  legacyAttempts: number;
  legacyDelayMs: number;
  maxWaitMs?: number;
  shouldWait?: (e: SimulationRefusal) => boolean;
  onWaiting?: (waiting: boolean) => void;
  onWaitingLong?: () => void;
  longWaitMs?: number;
  abortSignal?: AbortSignal;
  onRecheck?: (e: unknown, attempt: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

export async function presignWait<T>(send: () => Promise<T>, o: PresignWaitOptions): Promise<T> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  let saidLong = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await send();
      if (attempt > 0) o.onWaiting?.(false);
      return out;
    } catch (e) {
      if (!o.waitable(e)) {
        if (attempt > 0) o.onWaiting?.(false);
        throw e;
      }
      if (o.maxWaitMs === undefined) {
        if (attempt >= o.legacyAttempts) throw e;
        o.onRecheck?.(e, attempt + 1);
        await sleep(o.legacyDelayMs);
        continue;
      }
      if (o.abortSignal?.aborted) {
        o.onWaiting?.(false);
        throw new WaitStoppedError();
      }
      if (o.shouldWait && !o.shouldWait(e as SimulationRefusal)) {
        if (attempt > 0) o.onWaiting?.(false);
        throw e;
      }
      if (waited >= o.maxWaitMs) {
        o.onWaiting?.(false);
        throw new WaitExhaustedError(e);
      }
      o.onWaiting?.(true);
      o.onRecheck?.(e, attempt + 1);
      const delay = WAIT_DELAYS_MS[Math.min(attempt, WAIT_DELAYS_MS.length - 1)];
      await sleep(delay);
      waited += delay;
      if (!saidLong && waited >= (o.longWaitMs ?? 30_000)) {
        saidLong = true;
        o.onWaitingLong?.();
      }
      if (o.abortSignal?.aborted) {
        o.onWaiting?.(false);
        throw new WaitStoppedError();
      }
    }
  }
}
