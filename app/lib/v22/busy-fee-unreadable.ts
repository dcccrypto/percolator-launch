/**
 * Owner decision 3 (round 10): the busy-side fee check FAILS CLOSED. When the app cannot read what it needs to know the fee terms of an
 * order (an RPC error, a timeout, a missing or unreadable market / matcher / LP account), the order is not sent and the wallet is never
 * asked to sign. Thrown before any signature; the trader can simply try again.
 */
export const BUSY_FEE_UNREADABLE_MESSAGE =
  "We couldn't check the busy-side fee right now, so we didn't send your order. Nothing was signed. Try again in a moment.";

export class BusyFeeUnreadableError extends Error {
  constructor(cause?: unknown) {
    super(BUSY_FEE_UNREADABLE_MESSAGE, cause === undefined ? undefined : { cause });
    this.name = "BusyFeeUnreadableError";
  }
}

/** Waits `ms`, then rejects. Cleared by the caller when the race is won. */
export function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new BusyFeeUnreadableError(new Error(`timed out after ${ms} ms`))), ms);
    run().then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
