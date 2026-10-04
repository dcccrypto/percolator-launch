/**
 * Durable store for lib/adl-since.ts: one small JSON object in Vercel Blob (same pattern as
 * lib/playground-registered-markets.ts), so the first-seen time survives lambda cold starts. Every failure
 * degrades to "no duration shown"; a market's health is never blocked on this store.
 */
import { list, put } from "@vercel/blob";
import { adlSinceChanged, reconcileAdlSince } from "@/lib/adl-since";
import type { AdlSinceMap } from "@/lib/adl-since";

export const ADL_SINCE_BLOB_PATHNAME = "playground/adl-since.json";

function isMap(v: unknown): v is AdlSinceMap {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === "number" && Number.isFinite(x));
}

/** In-process copy, used when the blob is unreadable (and in local dev with no blob token). */
let memory: AdlSinceMap = {};
/** The last successful blob read, to skip re-reading when nothing is close-only and nothing is stored. */
let lastRead: { at: number; map: AdlSinceMap } | null = null;
const SKIP_READ_FRESH_MS = 5 * 60_000;
/** A hung Blob must not stall /api/markets/health. */
export const BLOB_TIMEOUT_MS = 2_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`blob timeout after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function readBlob(): Promise<AdlSinceMap | null> {
  try {
    const { blobs } = await withTimeout(list({ prefix: ADL_SINCE_BLOB_PATHNAME, limit: 1 }), BLOB_TIMEOUT_MS);
    const hit = blobs.find((b) => b.pathname === ADL_SINCE_BLOB_PATHNAME);
    if (!hit) return {};
    const res = await fetch(`${hit.url}?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(BLOB_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isMap(body)) return null;
    lastRead = { at: Date.now(), map: body };
    return body;
  } catch {
    return null;
  }
}

async function writeBlob(map: AdlSinceMap): Promise<void> {
  await withTimeout(
    put(ADL_SINCE_BLOB_PATHNAME, JSON.stringify(map), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    }),
    BLOB_TIMEOUT_MS,
  );
  lastRead = { at: Date.now(), map };
}

/**
 * Record what this health read observed and return the first-seen map for the observed slabs.
 * Writes only when something changed (an episode started or ended), never per request.
 */
/** Test hook. */
export function __resetAdlSinceStore(): void {
  memory = {};
  lastRead = null;
}

export async function recordAdlObservations(
  observed: ReadonlyArray<{ slab: string; reduceOnly: boolean | null }>,
  nowMs: number = Date.now(),
): Promise<AdlSinceMap> {
  // Nothing close-only now and nothing stored for these slabs a moment ago: there is nothing to start or end.
  const anyReduceOnly = observed.some((o) => o.reduceOnly === true);
  if (
    !anyReduceOnly &&
    lastRead !== null &&
    nowMs - lastRead.at < SKIP_READ_FRESH_MS &&
    observed.every((o) => lastRead!.map[o.slab] === undefined)
  ) {
    return {};
  }
  const stored = await readBlob();
  const prev = stored ?? memory;
  const next = reconcileAdlSince(prev, observed, nowMs);
  memory = next;
  if (stored !== null && adlSinceChanged(stored, next)) {
    try {
      await writeBlob(next);
    } catch (err) {
      console.warn("[adl-since] write failed:", err instanceof Error ? err.message : String(err));
    }
  }
  return next;
}
