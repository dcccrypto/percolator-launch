/**
 * Browser side of the push feed: mark/oracle ticks and last-trade messages for one slab, over the
 * SAME shared socket the price store already uses (lib/priceStore/wsManager.ts, one real socket
 * per URL however many charts subscribe).
 *
 * Guarantees to the consumer:
 *  - each (epoch, seq) tick is delivered at most once, in order;
 *  - a seq jump inside one epoch triggers a replay from the server's buffer (GET /ticks), so a
 *    dropped message never leaves a hole in the forming candle;
 *  - a reconnect (socket closed -> open again) replays everything after the last seq and fires
 *    `onReconnect` so the caller can also re-read the persisted tail;
 *  - a server restart (new epoch) is accepted as a fresh baseline and fires `onReconnect`.
 */
import type { TickMessage } from "./perp-types";
import type { TradeMessage } from "./trade-feed";

export type WsStatus = "connecting" | "open" | "closed";

/** The slice of WsManagerHandle this client needs (so tests inject a fake). */
export interface WsLike {
  subscribeChannel(channel: string): () => void;
  onMessageForChannel(channel: string, listener: (data: unknown) => void): () => void;
  onStatusChange(listener: (status: WsStatus) => void): () => void;
  getStatus(): WsStatus;
}

export type FetchJson = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface LiveHandlers {
  onTick(m: TickMessage): void;
  onTrade?(m: TradeMessage): void;
  /** The stream was interrupted and repaired (or restarted): re-read persisted history if you care. */
  onReconnect?(): void;
}

export function wsToHttpBase(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "");
}

export function parseTick(raw: unknown): TickMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Partial<TickMessage>;
  if (m.type !== "tick" || typeof m.slab !== "string" || typeof m.epoch !== "string") return null;
  if (!Number.isSafeInteger(m.seq) || !Number.isFinite(m.landedMs) || !Number.isFinite(m.slot)) return null;
  const mark = m.mark ?? null;
  const oracle = m.oracle ?? null;
  const okPrice = (p: unknown) => p === null || (typeof p === "number" && Number.isFinite(p) && p > 0);
  if (!okPrice(mark) || !okPrice(oracle) || (mark === null && oracle === null)) return null;
  return {
    type: "tick", slab: m.slab, epoch: m.epoch, seq: m.seq as number, slot: m.slot as number,
    landedMs: m.landedMs as number, recvMs: Number.isFinite(m.recvMs) ? (m.recvMs as number) : 0, mark, oracle,
  };
}

export function parseTrade(raw: unknown): TradeMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Partial<TradeMessage>;
  if (m.type !== "trade" || typeof m.slab !== "string" || typeof m.id !== "string") return null;
  if (typeof m.price !== "number" || !(m.price > 0) || !Number.isFinite(m.price)) return null;
  if (typeof m.size !== "number" || !Number.isFinite(m.size)) return null;
  if (typeof m.ts !== "number" || !Number.isFinite(m.ts)) return null;
  return { type: "trade", slab: m.slab, id: m.id, price: m.price, size: m.size, side: m.side === "long" || m.side === "short" ? m.side : null, ts: m.ts };
}

export interface LiveClient {
  subscribe(slab: string, h: LiveHandlers): () => void;
}

export function createLiveClient(opts: { ws: WsLike; httpBase: string; fetchJson: FetchJson }): LiveClient {
  return {
    subscribe(slab, h) {
      let epoch: string | null = null;
      let lastSeq = 0;
      let repairing = false;
      let buffered: TickMessage[] = [];
      let wasOpen = opts.ws.getStatus() === "open";
      let disposed = false;
      const seenTrades = new Set<string>();

      const accept = (m: TickMessage) => {
        if (epoch !== m.epoch) {
          // First tick ever, or the server restarted: a new baseline, nothing to repair from.
          const restarted = epoch !== null;
          epoch = m.epoch;
          lastSeq = m.seq;
          h.onTick(m);
          if (restarted) h.onReconnect?.();
          return;
        }
        if (m.seq <= lastSeq) return; // duplicate or replayed
        if (m.seq > lastSeq + 1) { void repair(m); return; }
        lastSeq = m.seq;
        h.onTick(m);
      };

      async function repair(trigger: TickMessage | null) {
        if (repairing) { if (trigger) buffered.push(trigger); return; }
        repairing = true;
        if (trigger) buffered.push(trigger);
        let repaired = false;
        try {
          const url = `${opts.httpBase}/ticks?slab=${encodeURIComponent(slab)}&sinceSeq=${lastSeq}&epoch=${encodeURIComponent(epoch ?? "")}`;
          const r = await opts.fetchJson(url);
          if (r.ok) {
            const body = (await r.json()) as { epoch?: unknown; ticks?: unknown };
            const ticks = Array.isArray(body.ticks) ? body.ticks.map(parseTick).filter((t): t is TickMessage => t !== null) : [];
            for (const t of ticks) { if (!disposed) accept(t); }
            repaired = true;
          }
        } catch {
          /* handled below: the held ticks are delivered with the gap acknowledged */
        } finally {
          repairing = false;
          const pending = buffered;
          buffered = [];
          pending.sort((a, b) => a.seq - b.seq);
          for (const t of pending) {
            if (disposed || t.epoch !== epoch) { if (!disposed) accept(t); continue; }
            if (t.seq <= lastSeq) continue;
            // Repair failed: deliver the live tick anyway (the close is right; only the in-between
            // highs/lows are missing) and let onReconnect re-read the persisted tail. Never loop on a dead endpoint.
            lastSeq = t.seq;
            h.onTick(t);
            if (!repaired) h.onReconnect?.();
          }
        }
      }

      const offChannel = opts.ws.subscribeChannel(slab);
      const offMsg = opts.ws.onMessageForChannel(slab, (data) => {
        if (disposed) return;
        const t = parseTick(data);
        if (t) { accept(t); return; }
        const tr = parseTrade(data);
        if (tr && h.onTrade && !seenTrades.has(tr.id)) {
          seenTrades.add(tr.id);
          if (seenTrades.size > 500) seenTrades.delete(seenTrades.values().next().value as string);
          h.onTrade(tr);
        }
      });
      const offStatus = opts.ws.onStatusChange((s) => {
        if (s === "open" && !wasOpen) {
          wasOpen = true;
          if (epoch !== null) void repair(null).then(() => { if (!disposed) h.onReconnect?.(); });
          else h.onReconnect?.();
        } else if (s !== "open") {
          wasOpen = false;
        }
      });
      return () => {
        disposed = true;
        offStatus();
        offMsg();
        offChannel();
      };
    },
  };
}
