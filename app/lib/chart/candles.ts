/**
 * Pure candle aggregation for tick series (mark / oracle). No I/O, no clock reads:
 * everything is a function of its inputs so the SAME code runs in the price-ws
 * server (canonical aggregation + persistence) and in the browser (the forming
 * candle, updated per pushed tick) and produces identical bars.
 *
 * Rules (perp-DEX convention):
 *  - a bucket is [t, t+res); `t` is aligned in UTC.
 *  - the FIRST candle of a new bucket opens at the previous candle's close
 *    (continuity: no visual gaps between bars on a continuously-marked series),
 *    except the very first candle ever seen, which opens at its first tick.
 *  - high/low include the open, so a gap-up open still has high >= open.
 *  - ticks older than the bucket of the newest candle are rejected (late ticks do not
 *    rewrite history; the server's persisted candle is canonical).
 */
import { CANDLE_RES_MINUTES, type Candle, type CandleResMinutes } from "./perp-types";

export function bucketStartSec(tsSec: number, resMinutes: number): number {
  const size = resMinutes * 60;
  return Math.floor(tsSec / size) * size;
}

export function isUsablePrice(p: unknown): p is number {
  return typeof p === "number" && Number.isFinite(p) && p > 0;
}

/**
 * Fold one observation into the newest candle. Returns the candle to emit/persist, or
 * null when the tick is unusable or older than `last`'s bucket. Never mutates `last`.
 */
export function foldTick(
  last: Candle | null,
  price: number,
  tsMs: number,
  resMinutes: number,
): Candle | null {
  if (!isUsablePrice(price) || !Number.isFinite(tsMs)) return null;
  const t = bucketStartSec(Math.floor(tsMs / 1000), resMinutes);
  if (!last) return { t, o: price, h: price, l: price, c: price, n: 1 };
  if (t < last.t) return null;
  if (t === last.t) {
    return { t, o: last.o, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price, n: last.n + 1 };
  }
  const open = last.c;
  return { t, o: open, h: Math.max(open, price), l: Math.min(open, price), c: price, n: 1 };
}

/**
 * Forming candles for every resolution of ONE (slab, series). `apply` returns the
 * candles that changed (one per resolution) so a caller can push/persist exactly those.
 */
export class CandleBook {
  private readonly forming = new Map<CandleResMinutes, Candle>();

  constructor(seed?: Partial<Record<CandleResMinutes, Candle>>) {
    if (seed) for (const r of CANDLE_RES_MINUTES) { const c = seed[r]; if (c) this.forming.set(r, c); }
  }

  apply(price: number, tsMs: number): Array<{ res: CandleResMinutes; candle: Candle; closed: Candle | null }> {
    const out: Array<{ res: CandleResMinutes; candle: Candle; closed: Candle | null }> = [];
    for (const res of CANDLE_RES_MINUTES) {
      const prev = this.forming.get(res) ?? null;
      const next = foldTick(prev, price, tsMs, res);
      if (!next) continue;
      this.forming.set(res, next);
      out.push({ res, candle: next, closed: prev && prev.t < next.t ? prev : null });
    }
    return out;
  }

  get(res: CandleResMinutes): Candle | null {
    return this.forming.get(res) ?? null;
  }
}

/**
 * Merge two ascending candle arrays (`base` older/persisted, `fresh` newer/live) into one
 * ascending, de-duplicated array. On a timestamp collision `fresh` wins.
 */
export function mergeCandles(base: readonly Candle[], fresh: readonly Candle[]): Candle[] {
  const byT = new Map<number, Candle>();
  for (const c of base) byT.set(c.t, c);
  for (const c of fresh) byT.set(c.t, c);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Roll finer candles (ascending) up into `resMinutes` buckets. Used by backfill (e.g. 1m -> 5m when a source lacks 5m). */
export function rollUp(fine: readonly Candle[], resMinutes: number): Candle[] {
  const out: Candle[] = [];
  for (const c of fine) {
    const t = bucketStartSec(c.t, resMinutes);
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.n += c.n;
    } else {
      out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c, n: c.n });
    }
  }
  return out;
}

/** Drop candles that are not finite/positive or have h < l (defence against a corrupt source row). */
export function sanitizeCandles(cs: readonly Candle[]): Candle[] {
  return cs.filter(
    (c) =>
      Number.isFinite(c.t) &&
      [c.o, c.h, c.l, c.c].every(isUsablePrice) &&
      c.h >= c.l &&
      c.h >= Math.max(c.o, c.c) - 1e-18 &&
      c.l <= Math.min(c.o, c.c) + 1e-18,
  );
}
