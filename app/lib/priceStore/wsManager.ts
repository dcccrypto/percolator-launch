"use client";

/**
 * Shared, reference-counted WebSocket connection manager — ONE real socket
 * per URL no matter how many callers subscribe. Modeled directly on dYdX
 * v4-web's `IndexerWebsocketManager` / `ReconnectingWebSocket`
 * (`src/bonsai/websocket/lib/indexerWebsocket.ts:97-113`,
 * `reconnectingWebsocket.ts:44-83`, cited in perp-dex-reference-patterns.md
 * Area 6), adapted to Percolator's existing wire protocol
 * (percolator-api's `src/routes/ws.ts`: legacy `{type:"subscribe",
 * slabAddress}` / `{type:"unsubscribe", slabAddress}` messages, server
 * replies with `{type:"price", slab, price, ...}`).
 *
 * Fixes the problem `useLivePrice.ts` used to self-document in its own file
 * header: "WebSocket: still one connection per subscriber today." Confirmed
 * in Phase 0's baseline that `TradeForm`/`AccountRiskSidebar`/etc. each
 * mount TWICE simultaneously (mobile + desktop copies, both always in the
 * DOM) — under the old per-hook-instance design that alone meant 2 sockets
 * per browser tab for one slab; with N components each independently
 * calling `useLivePrice()`, it was N sockets. This manager collapses all of
 * that to exactly one socket per distinct WS URL.
 */

export type WsConnectionStatus = "connecting" | "open" | "closed";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
// Jitter: randomise within ±25% of the computed delay to prevent
// thundering-herd reconnects when the server recovers and every client
// retries in unison — same constant/formula as the pre-refactor useLivePrice.ts.
const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);

/**
 * How long to keep a socket alive after the last channel + listener releases
 * it, so route changes / rapid remounts (React Strict Mode double-invoke,
 * switching trade tabs) don't thrash the connection. dYdX uses ~23s ("just
 * above the websocket subscribe timeout because of race conditions in the
 * indexer backend"); Percolator's server has no published subscribe
 * timeout, so a slightly rounder 20s is used — long enough to survive a
 * market-switch round trip, short enough not to leak sockets when a user
 * actually navigates away from trading entirely.
 */
const TEARDOWN_DELAY_MS = 20_000;

/**
 * Force a reconnect if the socket is OPEN but no message of any kind
 * (including the server's own ping/heartbeat) has arrived in this long —
 * the "stale-but-still-open" failure mode `useLivePrice.ts`'s own SECURITY
 * REVIEW comment flagged as undetected ("the WS feature becomes a no-op
 * with no user-visible indication"). Percolator's server pings every 30s
 * (BH2 heartbeat, `percolator-api/src/routes/ws.ts`), so 45s gives one
 * missed heartbeat of slack before acting — this is the
 * `MissingMessageDetector` pattern from dYdX, timer-driven and independent
 * of the socket's own `close` event.
 */
const STALE_CONNECTION_MS = 45_000;
const STALE_CHECK_INTERVAL_MS = 5_000;
const MAX_RETRIES = 20;

interface ManagerState {
  url: string;
  ws: WebSocket | null;
  status: WsConnectionStatus;
  reconnectDelay: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  teardownTimer: ReturnType<typeof setTimeout> | null;
  staleCheckTimer: ReturnType<typeof setInterval> | null;
  lastMessageAt: number;
  channelRefcounts: Map<string, number>;
  rawListeners: Set<(data: unknown) => void>;
  statusListeners: Set<(status: WsConnectionStatus) => void>;
  destroyed: boolean;
  retryCount: number;
}

const managers = new Map<string, ManagerState>();

function send(state: ManagerState, payload: unknown): void {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    try {
      state.ws.send(JSON.stringify(payload));
    } catch {
      /* ignore — a dead-but-not-yet-closed socket will be replaced on the next reconnect */
    }
  }
}

function setStatus(state: ManagerState, status: WsConnectionStatus): void {
  if (state.status === status) return;
  state.status = status;
  for (const l of state.statusListeners) l(status);
}

function resubscribeAllChannels(state: ManagerState): void {
  for (const channel of state.channelRefcounts.keys()) {
    send(state, { type: "subscribe", slabAddress: channel });
  }
}

function scheduleReconnect(state: ManagerState): void {
  if (state.destroyed || state.reconnectTimer) return;
  state.retryCount++;
  if (state.retryCount > MAX_RETRIES) {
    console.error("[wsManager] Max reconnect retries reached, giving up.");
    return;
  }
  const delay = jitter(state.reconnectDelay);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, RECONNECT_MAX_MS);
    connect(state);
  }, delay);
}

function connect(state: ManagerState): void {
  if (state.destroyed || !state.url) return;
  setStatus(state, "connecting");

  let ws: WebSocket;
  try {
    ws = new WebSocket(state.url);
  } catch {
    scheduleReconnect(state);
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    if (state.ws !== ws) return; // superseded by a later connect() call
    state.reconnectDelay = RECONNECT_BASE_MS;
    state.retryCount = 0;
    state.lastMessageAt = Date.now();
    setStatus(state, "open");
    resubscribeAllChannels(state);
  };

  ws.onmessage = (event) => {
    if (state.ws !== ws) return;
    state.lastMessageAt = Date.now();
    let data: unknown;
    try {
      data = JSON.parse(event.data as string);
    } catch {
      return;
    }
    for (const l of state.rawListeners) l(data);
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    setStatus(state, "closed");
    if (!state.destroyed) scheduleReconnect(state);
  };

  ws.onerror = () => {
    /* onclose fires right after in every browser tested; nothing to do here. */
  };
}

function ensureStaleCheck(state: ManagerState): void {
  if (state.staleCheckTimer) return;
  state.staleCheckTimer = setInterval(() => {
    if (state.status !== "open") return;
    if (Date.now() - state.lastMessageAt <= STALE_CONNECTION_MS) return;
    // Stale-but-open: onclose never fires on its own here, so the normal
    // reconnect path never runs. Force it — independent of the socket's own
    // close event, per the MissingMessageDetector pattern.
    try {
      state.ws?.close();
    } catch {
      /* ignore */
    }
    state.ws = null;
    setStatus(state, "closed");
    scheduleReconnect(state);
  }, STALE_CHECK_INTERVAL_MS);
}

function getOrCreateManager(url: string): ManagerState {
  const existing = managers.get(url);
  if (existing) {
    if (existing.teardownTimer) {
      clearTimeout(existing.teardownTimer);
      existing.teardownTimer = null;
    }
    return existing;
  }
  const state: ManagerState = {
    url,
    ws: null,
    status: "closed",
    reconnectDelay: RECONNECT_BASE_MS,
    reconnectTimer: null,
    teardownTimer: null,
    staleCheckTimer: null,
    lastMessageAt: Date.now(),
    channelRefcounts: new Map(),
    rawListeners: new Set(),
    statusListeners: new Set(),
    destroyed: false,
    retryCount: 0,
  };
  managers.set(url, state);
  return state;
}

function maybeScheduleTeardown(state: ManagerState): void {
  if (state.channelRefcounts.size > 0 || state.rawListeners.size > 0) return;
  if (state.teardownTimer) return;
  state.teardownTimer = setTimeout(() => {
    state.destroyed = true;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    if (state.staleCheckTimer) clearInterval(state.staleCheckTimer);
    try {
      state.ws?.close();
    } catch {
      /* ignore */
    }
    managers.delete(state.url);
  }, TEARDOWN_DELAY_MS);
}

export interface WsManagerHandle {
  /** Register interest in a channel (a slab address). Sends the subscribe
   *  message to the server on the FIRST caller for that channel; refcounts
   *  subsequent callers so N interested parties still send exactly one
   *  subscribe message. Returns a release function; the unsubscribe message
   *  is sent only once the LAST caller releases. */
  subscribeChannel(channel: string): () => void;
  /** Register a raw message listener — fires for every message on this
   *  URL's socket. Routing/filtering by channel is the caller's job (see
   *  priceStore.ts, which filters by `msg.slab === slab`). */
  onMessage(listener: (data: unknown) => void): () => void;
  onStatusChange(listener: (status: WsConnectionStatus) => void): () => void;
  getStatus(): WsConnectionStatus;
}

/**
 * Get (or lazily create) the shared manager for a URL. Safe to call from
 * many components/hooks — they all share the same underlying connection.
 * Returns an inert no-op handle when `url` is empty, matching the existing
 * "WS disabled" convention (empty `NEXT_PUBLIC_WS_URL` means no connection
 * is ever attempted) so call sites never need an `if (url)` branch.
 *
 * Must only be called from inside a `useEffect`/subscribe callback (never
 * during render) — see priceStore.ts's `subscribeSlab`, which is the sole
 * caller and is itself only ever invoked by React's `useSyncExternalStore`
 * internals or a chart's own `useEffect`, never synchronously during render.
 */
export function getWsManager(url: string): WsManagerHandle {
  if (!url) {
    return {
      subscribeChannel: () => () => {},
      onMessage: () => () => {},
      onStatusChange: () => () => {},
      getStatus: () => "closed",
    };
  }

  const state = getOrCreateManager(url);
  if (state.status === "closed" && !state.ws && !state.reconnectTimer) {
    connect(state);
    ensureStaleCheck(state);
  }

  return {
    subscribeChannel(channel: string) {
      const count = state.channelRefcounts.get(channel) ?? 0;
      state.channelRefcounts.set(channel, count + 1);
      if (count === 0 && state.status === "open") {
        send(state, { type: "subscribe", slabAddress: channel });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const c = state.channelRefcounts.get(channel) ?? 0;
        if (c <= 1) {
          state.channelRefcounts.delete(channel);
          send(state, { type: "unsubscribe", slabAddress: channel });
          maybeScheduleTeardown(state);
        } else {
          state.channelRefcounts.set(channel, c - 1);
        }
      };
    },
    onMessage(listener) {
      state.rawListeners.add(listener);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.rawListeners.delete(listener);
        maybeScheduleTeardown(state);
      };
    },
    onStatusChange(listener) {
      state.statusListeners.add(listener);
      return () => {
        state.statusListeners.delete(listener);
      };
    },
    getStatus() {
      return state.status;
    },
  };
}
