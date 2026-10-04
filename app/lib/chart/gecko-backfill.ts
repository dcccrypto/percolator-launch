/**
 * Pre-launch / pre-history backfill of the ORACLE series from GeckoTerminal (keyless).
 *
 * Why: at launch our own tick history is empty, so a fresh chart would be blank. The pool's
 * own OHLCV is the honest stand-in for the oracle series (the oracle IS the pool price), and
 * the rows are stored with src='gecko' so the UI can say where the old part comes from.
 *
 * Constraints this module exists to respect:
 *  - Keyless GeckoTerminal allows ~5 calls in a burst, then 429. So every call goes through one
 *    process-wide queue with a minimum spacing, a cool-down after a 429, and per-key single flight.
 *  - CoinGecko's terms require a cache refreshed at least every 24 h. The ledger (chart_backfill)
 *    gates a re-pull at REFRESH_MS (20 h), and a pull is only attempted when it is due.
 *  - Server-side only, never from the browser, never per viewer.
 */
import { geckoFetch, getGeckoConfig } from "../gecko-fetch";
import { sanitizeCandles } from "./candles";
import type { CandleStore } from "./candle-store";
import type { Candle, CandleResMinutes } from "./perp-types";

export const REFRESH_MS = 20 * 60 * 60_000;
export const MIN_SPACING_MS = 2_500;
export const COOLDOWN_AFTER_429_MS = 60_000;

const GECKO_FRAME: Record<CandleResMinutes, { timeframe: "minute" | "hour" | "day"; aggregate: number }> = {
  1: { timeframe: "minute", aggregate: 1 },
  5: { timeframe: "minute", aggregate: 5 },
  15: { timeframe: "minute", aggregate: 15 },
  60: { timeframe: "hour", aggregate: 1 },
  240: { timeframe: "hour", aggregate: 4 },
  1440: { timeframe: "day", aggregate: 1 },
};

export type GeckoPage = { ok: true; candles: Candle[] } | { ok: false; rateLimited: boolean };

/** Fetch one OHLCV page (newest 1000 bars) for a pool, ascending. USD-denominated. */
export async function fetchGeckoPage(pool: string, res: CandleResMinutes): Promise<GeckoPage> {
  const { timeframe, aggregate } = GECKO_FRAME[res];
  const url =
    `${getGeckoConfig().base}/pools/${encodeURIComponent(pool)}/ohlcv/${timeframe}` +
    `?aggregate=${aggregate}&limit=1000&currency=usd`;
  const r = await geckoFetch(url);
  if (!r) return { ok: false, rateLimited: false };
  if (r.status === 429) return { ok: false, rateLimited: true };
  if (!r.ok) return { ok: false, rateLimited: false };
  const json = (await r.json()) as { data?: { attributes?: { ohlcv_list?: unknown } } };
  const list = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return { ok: false, rateLimited: false };
  const candles: Candle[] = [];
  for (const b of list) {
    if (!Array.isArray(b) || b.length < 5) continue;
    candles.push({ t: Number(b[0]), o: Number(b[1]), h: Number(b[2]), l: Number(b[3]), c: Number(b[4]), n: 0 });
  }
  return { ok: true, candles: sanitizeCandles(candles).sort((a, b) => a.t - b.t) };
}

export interface BackfillDeps {
  store: CandleStore;
  poolForSlab(slab: string): Promise<string | null>;
  fetchPage?(pool: string, res: CandleResMinutes): Promise<GeckoPage>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface BackfillResult {
  status: "fresh" | "pulled" | "no-pool" | "rate-limited" | "failed" | "cooldown";
  bars: number;
}

// Process-wide state: one queue, one cool-down, per-key single flight.
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
let cooldownUntil = 0;
const inflight = new Map<string, Promise<BackfillResult>>();

/** Test hook. */
export function _resetBackfillState(): void {
  queue = Promise.resolve();
  lastCallAt = 0;
  cooldownUntil = 0;
  inflight.clear();
}

export function ensureOracleBackfill(slab: string, res: CandleResMinutes, deps: BackfillDeps): Promise<BackfillResult> {
  const key = `${slab}|${res}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async (): Promise<BackfillResult> => {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const last = await deps.store.backfilledAt(slab, res);
    if (now() - last < REFRESH_MS) return { status: "fresh", bars: 0 };
    if (now() < cooldownUntil) return { status: "cooldown", bars: 0 };
    const pool = await deps.poolForSlab(slab);
    if (!pool) return { status: "no-pool", bars: 0 };

    // Serialise every upstream call behind one queue with minimum spacing.
    const run = queue.then(async (): Promise<GeckoPage> => {
      if (now() < cooldownUntil) return { ok: false, rateLimited: true };
      const wait = lastCallAt + MIN_SPACING_MS - now();
      if (wait > 0) await sleep(wait);
      lastCallAt = now();
      return (deps.fetchPage ?? fetchGeckoPage)(pool, res);
    });
    queue = run.catch(() => undefined);
    const page = await run;
    if (!page.ok) {
      if (page.rateLimited) {
        cooldownUntil = now() + COOLDOWN_AFTER_429_MS;
        return { status: "rate-limited", bars: 0 };
      }
      return { status: "failed", bars: 0 };
    }
    await deps.store.upsert(page.candles.map((candle) => ({ slab, series: "oracle" as const, res, candle, src: "gecko" as const })));
    await deps.store.markBackfilled(slab, res, now(), page.candles.length);
    return { status: "pulled", bars: page.candles.length };
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
