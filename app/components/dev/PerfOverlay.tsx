"use client";

import { useEffect, useState } from "react";
import {
  subscribePerfSamples,
  isPerfInstrumentationEnabled,
  percentile,
  type PerfSpanKind,
} from "@/lib/perf/perfTiming";

/** Reads `?perf=1` from the URL once on mount (client-only, SSR-safe default of false). */
function useUrlPerfFlag(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    try {
      setEnabled(new URLSearchParams(window.location.search).get("perf") === "1");
    } catch {
      /* ignore */
    }
  }, []);
  return enabled;
}

/** Rolling FPS counter via a rAF loop, sampled once per wall-clock second. */
function useFps(active: boolean): number {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const loop = (t: number) => {
      frames++;
      if (t - last >= 1000) {
        setFps(frames);
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return fps;
}

function useSpanSamples(kind: PerfSpanKind, active: boolean): number[] {
  const [values, setValues] = useState<number[]>([]);
  useEffect(() => {
    if (!active) return;
    return subscribePerfSamples((k, sample) => {
      if (k !== kind) return;
      setValues((prev) => (prev.length >= 180 ? [...prev.slice(1), sample.ms] : [...prev, sample.ms]));
    });
  }, [kind, active]);
  return values;
}

function SpanRow({ label, values }: { label: string; values: number[] }) {
  return (
    <div className="tabular-nums text-[var(--text-secondary)]">
      {label} p50 <span className="text-[var(--text)]">{percentile(values, 50).toFixed(1)}</span>ms · p95{" "}
      <span className="text-[var(--text)]">{percentile(values, 95).toFixed(1)}</span>ms{" "}
      <span className="text-[var(--text-dim)]">(n={values.length})</span>
    </div>
  );
}

/**
 * Dev-only FPS + tick-latency overlay. Rendered only when
 * `NODE_ENV !== 'production'` OR the page URL has `?perf=1`.
 *
 * Self-contained: reads only from the module-level perf store (lib/perf/perfTiming.ts),
 * never from application/price state — mounting or unmounting this component
 * has zero effect on the rest of the trade page's render behaviour, so it's
 * safe to leave permanently mounted in the trade layout.
 */
export function PerfOverlay() {
  const urlFlag = useUrlPerfFlag();
  const show = isPerfInstrumentationEnabled() || urlFlag;

  const fps = useFps(show);
  const priceSamples = useSpanSamples("price-push-to-paint", show);
  const chartSamples = useSpanSamples("chart-tick-to-paint", show);

  if (!show) return null;

  return (
    <div
      className="fixed bottom-2 right-2 z-[9999] select-none rounded-none border border-[var(--border)] bg-[var(--bg)]/95 px-2.5 py-2 text-[10px] leading-relaxed shadow-lg backdrop-blur-sm"
      style={{ fontFamily: "var(--font-mono)" }}
      data-testid="perf-overlay"
    >
      <div className="mb-1 font-semibold uppercase tracking-[0.15em] text-[var(--text-dim)]">perf</div>
      <div className="tabular-nums text-[var(--text-secondary)]">
        fps <span className={fps > 0 && fps < 45 ? "text-[var(--short)]" : "text-[var(--long)]"}>{fps || "—"}</span>
      </div>
      <SpanRow label="price→paint" values={priceSamples} />
      <SpanRow label="chart→paint" values={chartSamples} />
    </div>
  );
}
