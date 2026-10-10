/**
 * Devnet v2.1: an order refused with Custom(121) EngineLossStale is RETRIED, never bundled.
 *
 * Before the engine fix (percolator #277 / percolator-prog #528) any risk-increasing order was
 * refused 121 while any positioned portfolio on the market was stale, so the v2.1 demo had to send
 * `[push, LP crank, refresh x N, order]` in one transaction (~114k CU per refresh: a market capped
 * at ~8 positioned accounts). With the fix an order is admitted while other portfolios are stale
 * whenever the hidden-loss bound is covered by insurance, and TradeCpi does the same-slot accrual
 * itself: `[order]` ALONE lands (measured in LiteSVM at ~317k CU with 55 stale positioned
 * portfolios). When the cover is short the order is still refused 121 and the keeper's background
 * sweep shrinks the bound, so the client waits a moment and sends the same order again.
 *
 * Retrying is safe: a 121 is raised by the pre-sign simulation (nothing was signed) or by a
 * transaction that failed as a whole (nothing landed). Every attempt rebuilds and re-simulates
 * the order, so the wallet only opens once the simulation is green. A confirmation timeout or any
 * other error is NOT a 121 and passes through untouched.
 *
 * Reduces and closes never needed refreshes; they simply never see a 121.
 */
import { extractErrorCode } from "@/lib/errorMessages";
import { isDevnetV21Enabled } from "./flag";
import { WRAPPER_ERR_V21 } from "./wrapper-errors";

/** The calm one-line state while an order waits to be sent again (button label + status body). */
export const V21_REFRESHING_POSITIONS = "Refreshing positions…";

/** ~1-2 s apart, ~15 s in total, then the calm failure line (the resolver's "loss-stale" copy). */
export const LOSS_STALE_RETRY_DELAYS_MS: readonly number[] = [1_000, 1_500, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000];

/**
 * The error is the WRAPPER's Custom(121). A refusal that names its program (lib/tx.ts
 * SimulationRefusal.programId) must name the wrapper: CPI callees reuse small numbers.
 */
export function isLossStaleError(err: unknown, wrapperProgramId?: string): boolean {
  if (!isDevnetV21Enabled()) return false;
  if (err === null || err === undefined) return false;
  const pid = typeof err === "object" ? (err as { programId?: unknown }).programId : undefined;
  if (typeof pid === "string" && wrapperProgramId !== undefined && pid !== wrapperProgramId) return false;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : safeJson(err);
  return extractErrorCode(msg) === WRAPPER_ERR_V21.EngineLossStale;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

export interface LossStaleRetryOptions {
  /** The wrapper program id (base58), for the attribution check. */
  wrapperProgramId?: string;
  delaysMs?: readonly number[];
  /** `true` while waiting to resend ("Refreshing positions…"), `false` once done either way. */
  onRefreshing?: (refreshing: boolean) => void;
  /** Stop waiting: the last 121 is thrown as is. */
  abortSignal?: AbortSignal;
  /** Test seam. Resolves true when aborted during the sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
}

/**
 * The state machine: send -> (121) -> refreshing, wait delays[i] -> send again ... -> after the
 * last delay the 121 is thrown. Any other error is thrown at once. `attempts` = delays.length + 1.
 */
export async function withLossStaleRetry<T>(send: () => Promise<T>, opts: LossStaleRetryOptions = {}): Promise<T> {
  const delays = opts.delaysMs ?? LOSS_STALE_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? abortableSleep;
  let refreshing = false;
  const done = () => {
    if (refreshing) {
      refreshing = false;
      opts.onRefreshing?.(false);
    }
  };
  for (let i = 0; ; i++) {
    try {
      const out = await send();
      done();
      return out;
    } catch (e) {
      if (!isLossStaleError(e, opts.wrapperProgramId) || i >= delays.length || opts.abortSignal?.aborted) {
        done();
        throw e;
      }
      if (!refreshing) {
        refreshing = true;
        opts.onRefreshing?.(true);
      }
      const stopped = await sleep(delays[i], opts.abortSignal);
      if (stopped) {
        done();
        throw e;
      }
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const onAbort = () => {
      clearTimeout(t);
      resolve(true);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
