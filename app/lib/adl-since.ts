/**
 * "Since when" for a close-only market (ADL reduce-only).
 *
 * The chain keeps no "entered reduce-only at" (the engine only holds `a_long` / `a_short`), so the start is
 * the first time /api/markets/health SAW the market reduce-only. That is a LOWER BOUND on the real
 * duration, so every string says "at least". Pure helpers; the durable store is lib/adl-since-store.ts.
 */

/** slab -> unix ms the market was first observed reduce-only. */
export type AdlSinceMap = Record<string, number>;

/**
 * Next map given what this read observed: a slab newly reduce-only gets `nowMs`; one that is no longer
 * reduce-only is dropped (a later episode starts a new clock); an existing entry never moves later.
 * `unknown` slabs (null reads) keep whatever they had: one failed read is not evidence the episode ended.
 */
export function reconcileAdlSince(
  prev: AdlSinceMap,
  observed: ReadonlyArray<{ slab: string; reduceOnly: boolean | null }>,
  nowMs: number,
): AdlSinceMap {
  const next: AdlSinceMap = { ...prev };
  for (const o of observed) {
    if (o.reduceOnly === null) continue;
    if (o.reduceOnly) {
      const had = next[o.slab];
      next[o.slab] = typeof had === "number" && Number.isFinite(had) && had <= nowMs ? had : nowMs;
    } else {
      delete next[o.slab];
    }
  }
  return next;
}

export function adlSinceChanged(a: AdlSinceMap, b: AdlSinceMap): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length !== kb.length || ka.some((k) => a[k] !== b[k]);
}

/** "35 min", "13 h", "2 d 4 h". Never "0": under a minute reads "under a minute". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "under a minute";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem === 0 ? `${days} d` : `${days} d ${rem} h`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Oct, 15:18 UTC". */
export function formatSinceUtc(sinceMs: number): string {
  const d = new Date(sinceMs);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm} UTC`;
}

/** One calm line: "Close-only for at least 13 h (since 3 Oct, 15:18 UTC)." */
export function closeOnlyDurationLine(sinceMs: number | null | undefined, nowMs: number): string | null {
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs) || sinceMs > nowMs) return null;
  return `Close-only for at least ${formatDuration(nowMs - sinceMs)} (since ${formatSinceUtc(sinceMs)}).`;
}
