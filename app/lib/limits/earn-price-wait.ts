/**
 * S-3 (v2.2 QA 2026-10-11): an Earn deposit on SOL sometimes sat on "Waiting for a fresh price. This
 * usually takes a few seconds." for over a minute with no wallet prompt, error or tx. That line is the
 * copy for a pre-sign refusal 26 / 27 (OracleInvalid / OracleStale); the trade ticket waits through it and
 * resends, but nothing on Earn ever re-checked, so the line never changed. With the v2.2 keeper pushing
 * every ~3 s / cranking every ~6 s the refusal is transient (12/12 back-to-back simulations of the same
 * deposit passed on 2026-10-11 12:42Z), so: re-check for up to 20 s while the wallet has NOT opened, then
 * stop with a clear line and let the user retry. A refusal after the wallet opened is never re-sent.
 */
import { WRAPPER_ERR } from "@/lib/wrapper-errors";

export const EARN_PRICE_WAIT_TIMEOUT_MS = 20_000;
export const EARN_PRICE_WAIT_INTERVAL_MS = 2_500;

export const EARN_PRICE_WAIT_COPY =
  "The market's price didn't update within 20 seconds, so nothing was deposited and your wallet wasn't asked to sign. Try again in a moment.";

export class EarnPriceWaitTimeoutError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(EARN_PRICE_WAIT_COPY);
    this.name = "EarnPriceWaitTimeoutError";
    this.cause = cause;
  }
}

/** A refusal the next price push clears, caught BEFORE the wallet opened (a pre-sign simulation). */
export function isPreSignPriceRefusal(e: unknown, wrapperProgramId: string): boolean {
  const r = e as { name?: unknown; code?: unknown; programId?: unknown } | null;
  if (!r || r.name !== "SimulationRefusal") return false;
  if (r.programId !== null && r.programId !== undefined && r.programId !== wrapperProgramId) return false;
  return r.code === WRAPPER_ERR.OracleStale || r.code === WRAPPER_ERR.OracleInvalid;
}

/**
 * Run `send`; while it is refused pre-sign for a stale / invalid price, re-check every `intervalMs` until
 * `timeoutMs`, then throw {@link EarnPriceWaitTimeoutError}. `onWaiting(true/false)` brackets the wait.
 */
export async function withEarnPriceWait<T>(
  send: () => Promise<T>,
  p: {
    wrapperProgramId: string;
    timeoutMs?: number;
    intervalMs?: number;
    onWaiting?: (waiting: boolean) => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const now = p.now ?? Date.now;
  const sleep = p.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (p.timeoutMs ?? EARN_PRICE_WAIT_TIMEOUT_MS);
  let waiting = false;
  try {
    for (;;) {
      try {
        return await send();
      } catch (e) {
        if (!isPreSignPriceRefusal(e, p.wrapperProgramId)) throw e;
        if (now() >= deadline) throw new EarnPriceWaitTimeoutError(e);
        if (!waiting) {
          waiting = true;
          p.onWaiting?.(true);
        }
        await sleep(p.intervalMs ?? EARN_PRICE_WAIT_INTERVAL_MS);
      }
    }
  } finally {
    if (waiting) p.onWaiting?.(false);
  }
}
