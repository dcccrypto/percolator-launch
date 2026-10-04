/**
 * Transport-free tick service for the price-ws process: auth + parse + hub + persistence.
 * scripts/local-price-ws-server.ts wires it to HTTP and WebSocket; tests drive it directly.
 */
import { bearerMatches, parseIngestBody } from "./tick-ingest";
import type { CandleStore } from "./candle-store";
import { TickHub } from "./tick-hub";
import type { TickMessage } from "./perp-types";

export const MAX_BODY_BYTES = 64 * 1024;

export interface TickServiceStats {
  ingestOk: number;
  ingestUnauthorized: number;
  ingestBad: number;
  ticksAccepted: number;
  ticksRejected: number;
  ticksDroppedBackwards: number;
  ticksDroppedUnknown: number;
  flushOk: number;
  flushFailed: number;
  lastIngestMs: number;
  lastFlushMs: number;
}

export type IngestResponse =
  | { status: 202; accepted: number; rejected: number }
  | { status: 400 | 401 | 413 | 503; error: string };

export interface TickService {
  readonly hub: TickHub;
  readonly stats: TickServiceStats;
  /** Returns the response plus the messages to fan out (empty on failure). */
  ingest(authHeader: string | undefined, body: string, onTick: (m: TickMessage) => void): IngestResponse;
  flush(): Promise<void>;
  replay(slab: string, sinceSeq: number, epoch: string | null): TickMessage[];
}

/** Rows per upsert statement: 10 parameters each, far below Postgres's 65,535-parameter ceiling. */
export const FLUSH_CHUNK_ROWS = 500;

export function createTickService(opts: {
  key: string | undefined;
  /** Only ticks for markets we serve are accepted; omit to accept any well-formed slab. */
  isKnownSlab?: (slab: string) => boolean;
  store: CandleStore | null;
  epoch: string;
  now?: () => number;
}): TickService {
  const now = opts.now ?? Date.now;
  const hub = new TickHub(opts.epoch);
  const stats: TickServiceStats = {
    ingestOk: 0, ingestUnauthorized: 0, ingestBad: 0,
    ticksAccepted: 0, ticksRejected: 0, ticksDroppedBackwards: 0, ticksDroppedUnknown: 0,
    flushOk: 0, flushFailed: 0, lastIngestMs: 0, lastFlushMs: 0,
  };
  let flushing = false;

  return {
    hub,
    stats,
    ingest(authHeader, body, onTick) {
      // A service with no key configured refuses everything: ingest is never open by default.
      if (!opts.key) return { status: 503, error: "ingest is not configured" };
      if (!bearerMatches(authHeader, opts.key)) {
        stats.ingestUnauthorized++;
        return { status: 401, error: "unauthorized" };
      }
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        stats.ingestBad++;
        return { status: 413, error: "body too large" };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        stats.ingestBad++;
        return { status: 400, error: "invalid json" };
      }
      const parsed = parseIngestBody(raw, now());
      if (!parsed.ok) {
        stats.ingestBad++;
        return { status: 400, error: parsed.error };
      }
      let accepted = 0;
      const recv = now();
      for (const t of parsed.ticks) {
        if (opts.isKnownSlab && !opts.isKnownSlab(t.slab)) { stats.ticksDroppedUnknown++; continue; }
        const m = hub.ingest(t, recv);
        if (m) {
          accepted++;
          onTick(m);
        } else {
          stats.ticksDroppedBackwards++;
        }
      }
      stats.ingestOk++;
      stats.ticksAccepted += accepted;
      stats.ticksRejected += parsed.rejected;
      stats.lastIngestMs = recv;
      return { status: 202, accepted, rejected: parsed.rejected + (parsed.ticks.length - accepted) };
    },
    async flush() {
      if (!opts.store || flushing) return;
      const rows = hub.drainDirty();
      if (rows.length === 0) return;
      flushing = true;
      let written = 0;
      try {
        // Chunked: a large dirty set must never become one statement over the parameter limit.
        for (; written < rows.length; written += FLUSH_CHUNK_ROWS) {
          await opts.store.upsert(rows.slice(written, written + FLUSH_CHUNK_ROWS).map((r) => ({ slab: r.slab, series: r.series, res: r.res, candle: r.candle })));
        }
        stats.flushOk++;
        stats.lastFlushMs = now();
      } catch (err) {
        stats.flushFailed++;
        hub.requeue(rows.slice(written));
        console.warn("[tick-service] candle flush failed:", err instanceof Error ? err.message : err);
      } finally {
        flushing = false;
      }
    },
    replay: (slab, sinceSeq, epoch) => hub.replay(slab, sinceSeq, epoch),
  };
}
