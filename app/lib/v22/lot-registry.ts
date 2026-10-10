/**
 * The lot exponent as a property of the MARKET (review N1). Every per-token price feed (WS ticks, the DB `last_price`)
 * must be scaled by 10^lotExp before it is stored in the per-LOT price store, so the store must know a slab's exponent
 * BEFORE it ingests such a feed, no matter which page subscribed. There is no page-level setter: the exponent enters
 * this registry from (a) any slab bytes the app reads (`observeLotExp`, at every ingestion point) and (b) a single
 * app-level loader (`setLotExpLoader`, installed once by `LotExpLoaderBridge`) that the price store triggers for any
 * slab it is asked to price while the exponent is unknown.
 *
 * Flag off: every slab is known with exponent 0 (nothing is loaded, nothing changes).
 * Unknown (flag on, not yet read, or the read failed): `getLotExp` returns null and consumers must NOT turn a price
 * of that slab into USD / PnL / liquidation figures or a limit price.
 */
import { isDevnetV22Enabled } from "./flag";
import { lotExpOfMarketV22 } from "./sdk";

const known = new Map<string, number>();
const listeners = new Set<(slab: string, lotExp: number) => void>();
const inflight = new Map<string, number>(); // slab -> last attempt ms
let loader: ((slab: string) => Promise<number | null>) | null = null;
let clock: () => number = () => Date.now();
/** Do not retry a failed load of the same slab more often than this. */
export const LOT_LOAD_RETRY_MS = 10_000;

/** Test seam. */
export function __resetLotRegistryForTest(c?: () => number): void {
  known.clear();
  inflight.clear();
  loader = null;
  clock = c ?? (() => Date.now());
}

/** The exponent of `raw` (a market account), or null when it is not a readable market of a known VERSION. */
export function lotExpOfStrict(raw: Uint8Array | null | undefined, assetIndex = 0): number | null {
  if (!raw) return null;
  try {
    return lotExpOfMarketV22(raw, assetIndex);
  } catch {
    return null;
  }
}

/** Is the exponent of `slab` known? Flag off: always (as 0). */
export function getLotExp(slab: string | null | undefined): number | null {
  if (!isDevnetV22Enabled()) return 0;
  if (!slab) return null;
  return known.get(slab) ?? null;
}

/** Record `slab`'s exponent from market bytes the app just read. Unreadable bytes change nothing. */
export function observeLotExp(slab: string | null | undefined, raw: Uint8Array | null | undefined): void {
  if (!slab || !isDevnetV22Enabled()) return;
  const k = lotExpOfStrict(raw);
  if (k === null) return;
  setKnown(slab, k);
}

function setKnown(slab: string, k: number): void {
  const prev = known.get(slab);
  known.set(slab, k);
  if (prev === k) return;
  for (const l of [...listeners]) l(slab, k);
}

/** Be told when a slab's exponent becomes known (or changes). */
export function onLotExp(cb: (slab: string, lotExp: number) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The single app-level loader (reads the slab account). Null removes it. */
export function setLotExpLoader(fn: ((slab: string) => Promise<number | null>) | null): void {
  loader = fn;
}

/** Ask the loader for `slab`'s exponent if it is unknown (deduped, retried at most every LOT_LOAD_RETRY_MS). */
export function ensureLotExp(slab: string): void {
  if (!isDevnetV22Enabled() || known.has(slab) || !loader) return;
  const last = inflight.get(slab);
  const now = clock();
  if (last !== undefined && now - last < LOT_LOAD_RETRY_MS) return;
  inflight.set(slab, now);
  const run = loader;
  void run(slab)
    .then((k) => {
      if (k !== null) setKnown(slab, k);
    })
    .catch(() => {
      /* unknown stays unknown; a later subscribe retries after the cooldown */
    });
}
