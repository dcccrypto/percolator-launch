"use client";

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

const ENABLED = process.env.NODE_ENV !== "production";

/**
 * Dev-only wrapper around React's built-in <Profiler> API — the same data
 * source React DevTools' "Profiler" tab reads, exposed programmatically so
 * it can be captured headlessly (Playwright console capture) instead of
 * requiring a human to click through the DevTools UI.
 *
 * Logs one line per commit to console.debug in a greppable format:
 *   [render-profiler] <id> phase=<mount|update|nested-update> actualDuration=<ms>ms baseDuration=<ms>ms commitTime=<ms>
 *
 * How to read it (documenting "how to read React DevTools Profiler
 * re-render counts" per the Phase 0 instrumentation brief):
 *   1. Programmatic / headless: grep browser console for
 *      `[render-profiler] <id>` and count `phase=update` lines within a
 *      fixed observation window → "re-renders per N seconds" for that id.
 *      `actualDuration` is the per-commit render cost in ms for that
 *      subtree; `phase=mount` fires exactly once per id per real mount.
 *   2. Interactive: open React DevTools → Profiler tab → record → wait →
 *      stop. The flamegraph/ranked view shows the same id with the same
 *      commit count and duration — this component is the automatable
 *      equivalent of that workflow, not a replacement for it.
 *
 * No-op passthrough (renders children directly, no <Profiler> boundary, no
 * console output) in production — dead-code-eliminated cost is a single
 * `if` check.
 */
export function RenderProfiler({ id, children }: { id: string; children: ReactNode }) {
  if (!ENABLED) return <>{children}</>;

  const onRender: ProfilerOnRenderCallback = (profilerId, phase, actualDuration, baseDuration, _startTime, commitTime) => {
    // eslint-disable-next-line no-console
    console.debug(
      `[render-profiler] ${profilerId} phase=${phase} actualDuration=${actualDuration.toFixed(2)}ms baseDuration=${baseDuration.toFixed(2)}ms commitTime=${commitTime.toFixed(1)}`,
    );
  };

  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
