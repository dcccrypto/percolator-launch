/**
 * Live Percolator trades for one slab, from the price-WS service's
 * `trades:<slab>` channel (NEXT_PUBLIC_WS_URL) — the same feed
 * usePercolatorCandles uses. Ref-counted per slab: N chart listeners share
 * one socket. Reconnects with capped exponential backoff.
 */

export interface LiveTrade {
  price: number;
  size: number;
  /** Seconds since epoch. */
  tsSec: number;
}

export type TradeListener = (trade: LiveTrade) => void;

export interface TradeStream {
  subscribe(slab: string, listener: TradeListener): () => void;
}

interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** Parse one WS message into a trade for `slab`, or null. Liquidation markers (null/0 price) are dropped. */
export function parseTradeMessage(raw: unknown, slab: string): LiveTrade | null {
  let msg: unknown = raw;
  if (typeof raw === "string") {
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { type?: unknown; slab?: unknown; price?: unknown; size?: unknown; timestamp?: unknown };
  if (m.type !== "trade" || m.slab !== slab) return null;
  const price = Number(m.price);
  const size = Math.abs(Number(m.size));
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size)) return null;
  const tsMs = typeof m.timestamp === "number" && Number.isFinite(m.timestamp) ? m.timestamp : Date.now();
  return { price, size, tsSec: Math.floor(tsMs / 1000) };
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export function createTradeStream(url: string | null, makeSocket?: SocketFactory): TradeStream {
  const factory: SocketFactory =
    makeSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
  const entries = new Map<
    string,
    { listeners: Set<TradeListener>; socket: SocketLike | null; timer: ReturnType<typeof setTimeout> | null; delay: number; closed: boolean }
  >();

  const open = (slab: string) => {
    const e = entries.get(slab);
    if (!e || e.closed || !url) return;
    let sock: SocketLike;
    try {
      sock = factory(url);
    } catch {
      return;
    }
    e.socket = sock;
    sock.onopen = () => {
      e.delay = BACKOFF_BASE_MS;
      sock.send(JSON.stringify({ type: "subscribe", channels: [`trades:${slab}`] }));
    };
    sock.onmessage = (ev) => {
      const t = parseTradeMessage(ev.data, slab);
      if (t) for (const l of e.listeners) l(t);
    };
    sock.onerror = () => {
      /* onclose follows */
    };
    sock.onclose = () => {
      if (e.closed || e.socket !== sock) return;
      e.socket = null;
      e.timer = setTimeout(() => open(slab), e.delay);
      e.delay = Math.min(e.delay * 2, BACKOFF_MAX_MS);
    };
  };

  return {
    subscribe(slab, listener) {
      let e = entries.get(slab);
      if (!e) {
        e = { listeners: new Set(), socket: null, timer: null, delay: BACKOFF_BASE_MS, closed: false };
        entries.set(slab, e);
        e.listeners.add(listener);
        open(slab);
      } else {
        e.listeners.add(listener);
      }
      const entry = e;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) return;
        entry.closed = true;
        if (entry.timer) clearTimeout(entry.timer);
        try {
          entry.socket?.close();
        } catch {
          /* ignore */
        }
        entries.delete(slab);
      };
    },
  };
}
