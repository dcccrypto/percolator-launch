/**
 * Dev-only performance instrumentation for the trade-terminal rebuild
 * (Prompt: "rebuild the Percolator trade terminal to real perp-DEX quality").
 *
 * Two measured spans, both reported in milliseconds via `performance.now()`:
 *   - "price-push-to-paint": from the instant a new price tick lands in the
 *     price store (lib/priceStore.ts) to the next committed frame.
 *   - "chart-tick-to-paint": from the instant TradingChart calls
 *     series.update()/applyOptions() for a live tick to the next committed
 *     frame.
 *
 * "Paint" is approximated with a *double* requestAnimationFrame (schedule a
 * callback for the frame *after* the mutating frame). This is a well-known
 * proxy for "the browser has committed layout for the mutating frame" — see
 * MDN's "avoiding layout thrashing" pattern — NOT a real Paint Timing API
 * measurement (`PerformanceObserver({entryTypes: ['paint']})` reports only
 * first-paint/first-contentful-paint globally, not per-mutation). Documented
 * here so the number is never mistaken for a browser-native paint timestamp.
 *
 * Zero runtime cost in production: `ENABLED` is a `NODE_ENV` check that Next's
 * production build dead-code-eliminates, and `startPerfSpan()` returns a
 * no-op when disabled.
 */

const ENABLED = process.env.NODE_ENV !== "production";

export type PerfSpanKind = "price-push-to-paint" | "chart-tick-to-paint";

export interface PerfSample {
  kind: PerfSpanKind;
  ms: number;
  at: number; // Date.now() when the sample was recorded
}

/** Rolling window size per span kind — enough for a stable p50/p95 without unbounded growth. */
const MAX_SAMPLES = 180;

const samples: Record<PerfSpanKind, PerfSample[]> = {
  "price-push-to-paint": [],
  "chart-tick-to-paint": [],
};

type Listener = (kind: PerfSpanKind, sample: PerfSample) => void;
const listeners = new Set<Listener>();

function record(kind: PerfSpanKind, ms: number): void {
  const sample: PerfSample = { kind, ms, at: Date.now() };
  const arr = samples[kind];
  arr.push(sample);
  if (arr.length > MAX_SAMPLES) arr.shift();
  for (const l of listeners) l(kind, sample);
}

/**
 * Start a perf span. Call at the instant the new value becomes available
 * (price tick written to the store; chart series.update() about to run).
 * Returns a `finish()` callback to invoke synchronously right after the
 * mutating call — it schedules the double-rAF and records elapsed time.
 *
 * No-op (returns a no-op finish) when instrumentation is disabled, so call
 * sites never need their own `if (dev)` guard.
 */
export function startPerfSpan(kind: PerfSpanKind): () => void {
  if (!ENABLED) return () => {};
  const t0 = performance.now();
  return () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        record(kind, performance.now() - t0);
      });
    });
  };
}

/** Subscribe to new samples as they're recorded. Returns an unsubscribe function. */
export function subscribePerfSamples(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPerfSamples(kind: PerfSpanKind): readonly PerfSample[] {
  return samples[kind];
}

export function isPerfInstrumentationEnabled(): boolean {
  return ENABLED;
}

/** Simple percentile over a numeric array (nearest-rank, no interpolation — fine for a dev overlay). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
