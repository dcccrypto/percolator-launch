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

async function readBlob(): Promise<AdlSinceMap | null> {
  try {
    const { blobs } = await list({ prefix: ADL_SINCE_BLOB_PATHNAME, limit: 1 });
    const hit = blobs.find((b) => b.pathname === ADL_SINCE_BLOB_PATHNAME);
    if (!hit) return {};
    const res = await fetch(`${hit.url}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isMap(body) ? body : null;
  } catch {
    return null;
  }
}

async function writeBlob(map: AdlSinceMap): Promise<void> {
  await put(ADL_SINCE_BLOB_PATHNAME, JSON.stringify(map), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
}

/**
 * Record what this health read observed and return the first-seen map for the observed slabs.
 * Writes only when something changed (an episode started or ended), never per request.
 */
export async function recordAdlObservations(
  observed: ReadonlyArray<{ slab: string; reduceOnly: boolean | null }>,
  nowMs: number = Date.now(),
): Promise<AdlSinceMap> {
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
