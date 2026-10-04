/**
 * TickHub: the price-ws server's in-memory core for perp chart data.
 *
 *  - assigns (epoch, seq) to every accepted tick and keeps a short replay buffer so a
 *    reconnecting browser can repair a gap without a database round trip;
 *  - folds ticks into the canonical per-(slab, series, resolution) forming candles;
 *  - tracks which candles changed since the last flush so persistence writes only deltas.
 *
 * No I/O and no timers here: the caller owns the clock and the transports.
 */
import { CandleBook } from "./candles";
import { e6ToUsd } from "./tick-ingest";
import {
  CANDLE_RES_MINUTES,
  TICK_SERIES,
  type Candle,
  type CandleResMinutes,
  type IngestTick,
  type TickMessage,
  type TickSeries,
} from "./perp-types";

/** Replay horizon: a reconnect shorter than this is repaired from memory. */
export const REPLAY_WINDOW_MS = 10 * 60_000;
export const REPLAY_MAX_PER_SLAB = 600;
/** A mark more than this factor away from the previous one is not a push the keeper's circuit breaker would let through. */
export const MAX_MARK_JUMP = 20;

export interface DirtyCandle {
  slab: string;
  series: TickSeries;
  res: CandleResMinutes;
  candle: Candle;
}

interface SlabState {
  seq: number;
  ring: TickMessage[];
  books: Record<TickSeries, CandleBook>;
  lastLandedMs: number;
  lastSlot: number;
  lastMark: number | null;
}

export class TickHub {
  readonly epoch: string;
  private readonly slabs = new Map<string, SlabState>();
  private readonly dirty = new Map<string, DirtyCandle>();

  constructor(epoch: string) {
    this.epoch = epoch;
  }

  private state(slab: string): SlabState {
    let s = this.slabs.get(slab);
    if (!s) {
      s = { seq: 0, ring: [], books: { mark: new CandleBook(), oracle: new CandleBook() }, lastLandedMs: 0, lastSlot: 0, lastMark: null };
      this.slabs.set(slab, s);
    }
    return s;
  }

  /**
   * Continue a candle from persisted state after a restart (open stays the persisted open).
   * Never overrides a candle this process already formed: live data wins over a seed that
   * raced it.
   */
  seed(slab: string, series: TickSeries, res: CandleResMinutes, candle: Candle): void {
    const s = this.state(slab);
    const cur = s.books[series];
    if (cur.get(res)) return;
    const seed: Partial<Record<CandleResMinutes, Candle>> = {};
    for (const r of CANDLE_RES_MINUTES) {
      const c = cur.get(r);
      if (c) seed[r] = c;
    }
    seed[res] = candle;
    s.books[series] = new CandleBook(seed);
  }

  /**
   * Accept one keeper tick. Ticks whose landedMs goes BACKWARDS for a slab (a keeper
   * restart replaying, or a bad clock) are dropped so candle history is never rewritten.
   * Returns the message to fan out, or null when dropped.
   */
  ingest(t: IngestTick, recvMs: number): TickMessage | null {
    const s = this.state(t.slab);
    if (t.landedMs < s.lastLandedMs) return null;
    // The slot never goes backwards either: a replayed or forged older slot cannot rewrite the chart.
    if (t.slot < s.lastSlot) return null;
    const mark = e6ToUsd(t.markE6);
    // A mark that jumps more than MAX_MARK_JUMPx from the previous one is rejected (the keeper's
    // circuit breaker bounds real moves far below that), so one bad tick cannot wreck the axis.
    if (s.lastMark !== null && (mark > s.lastMark * MAX_MARK_JUMP || mark < s.lastMark / MAX_MARK_JUMP)) return null;
    s.lastLandedMs = t.landedMs;
    s.lastSlot = t.slot;
    s.lastMark = mark;
    const oracle = t.oracleE6 === null ? null : e6ToUsd(t.oracleE6);
    s.seq += 1;
    const msg: TickMessage = {
      type: "tick",
      slab: t.slab,
      epoch: this.epoch,
      seq: s.seq,
      slot: t.slot,
      landedMs: t.landedMs,
      recvMs,
      mark,
      oracle,
    };
    s.ring.push(msg);
    const cutoff = recvMs - REPLAY_WINDOW_MS;
    while (s.ring.length > REPLAY_MAX_PER_SLAB || (s.ring.length > 0 && s.ring[0].recvMs < cutoff)) s.ring.shift();

    for (const series of TICK_SERIES) {
      const price = series === "mark" ? mark : oracle;
      if (price === null) continue;
      for (const { res, candle } of s.books[series].apply(price, t.landedMs)) {
        this.dirty.set(`${t.slab}|${series}|${res}`, { slab: t.slab, series, res, candle });
      }
    }
    return msg;
  }

  latest(slab: string): TickMessage | null {
    const r = this.slabs.get(slab)?.ring;
    return r && r.length > 0 ? r[r.length - 1] : null;
  }

  /** Ticks with seq > sinceSeq (same epoch), oldest first. A different epoch replays the whole buffer. */
  replay(slab: string, sinceSeq: number, epoch: string | null): TickMessage[] {
    const r = this.slabs.get(slab)?.ring ?? [];
    if (epoch !== this.epoch) return r.slice();
    return r.filter((m) => m.seq > sinceSeq);
  }

  forming(slab: string, series: TickSeries, res: CandleResMinutes): Candle | null {
    return this.slabs.get(slab)?.books[series].get(res) ?? null;
  }

  /** Candles changed since the last drain (each (slab,series,res) once, newest state). */
  drainDirty(): DirtyCandle[] {
    const out = [...this.dirty.values()];
    this.dirty.clear();
    return out;
  }

  /** Put drained rows back after a failed flush (newer changes win). */
  requeue(rows: DirtyCandle[]): void {
    for (const r of rows) {
      const key = `${r.slab}|${r.series}|${r.res}`;
      if (!this.dirty.has(key)) this.dirty.set(key, r);
    }
  }

  slabCount(): number {
    return this.slabs.size;
  }
}
