/**
 * GH#2804: keep watching a tx whose confirmation timed out (`pollConfirmation` gave up after 90s,
 * but the tx may still land) until it resolves, so the UI can keep its submit disabled instead of
 * inviting a second send.
 *
 * `check` is `checkSignatureLanded` bound to a connection:
 *  - "landed"    -> resolved: the tx confirmed.
 *  - "not-found" -> counted as dropped only once EVERY check for `droppedAfterMs` said so (a lagging
 *                   RPC node can miss a just-confirmed signature, and the tx is ~90s old already, so
 *                   by then its blockhash has expired and it can no longer land).
 *  - "unknown"   -> indeterminate (RPC hiccup, processed-not-confirmed, or failed on-chain): keep
 *                   watching; resets the not-found run.
 * After `maxMs` without a verdict it gives up with "undetermined" (the caller re-enables the form
 * and points at the explorer instead of claiming either outcome).
 */
export type PendingSignatureOutcome = "landed" | "dropped" | "undetermined" | "aborted";

export interface WatchPendingSignatureOptions {
  intervalMs?: number;
  droppedAfterMs?: number;
  maxMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const PENDING_SIGNATURE_DEFAULTS = {
  intervalMs: 4_000,
  droppedAfterMs: 30_000,
  maxMs: 120_000,
} as const;

export async function watchPendingSignature(
  check: () => Promise<"landed" | "not-found" | "unknown">,
  opts: WatchPendingSignatureOptions = {},
): Promise<PendingSignatureOutcome> {
  const intervalMs = opts.intervalMs ?? PENDING_SIGNATURE_DEFAULTS.intervalMs;
  const droppedAfterMs = opts.droppedAfterMs ?? PENDING_SIGNATURE_DEFAULTS.droppedAfterMs;
  const maxMs = opts.maxMs ?? PENDING_SIGNATURE_DEFAULTS.maxMs;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  let notFoundSince: number | null = null;
  for (;;) {
    if (opts.signal?.aborted) return "aborted";
    let verdict: "landed" | "not-found" | "unknown";
    try {
      verdict = await check();
    } catch {
      verdict = "unknown";
    }
    if (opts.signal?.aborted) return "aborted";
    if (verdict === "landed") return "landed";
    if (verdict === "not-found") {
      notFoundSince ??= now();
      if (now() - notFoundSince >= droppedAfterMs) return "dropped";
    } else {
      notFoundSince = null;
    }
    if (now() - start >= maxMs) return "undetermined";
    await sleep(intervalMs);
  }
}
