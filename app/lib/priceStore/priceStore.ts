"use client";

/**
 * Price store — the single source of truth for "live price" per slab,
 * decoupled from React's render cycle. This is Phase 1 of the trade-terminal
 * rebuild (see perp-dex-reference-patterns.md Area 2 "keep tick-rate data
 * OUT of the normal render-triggering path" + Area 6 "one shared WS
 * connection, not one per hook instance").
 *
 * Shape (mirrors, in spirit, dYdX's WebsocketDerivedValue +
 * IndexerWebsocketManager, adapted to Percolator's existing wire protocol):
 *   - ONE shared WebSocket per URL (wsManager.ts), refcounted across every
 *     interested slab/listener.
 *   - Incoming ticks are buffered per-slab and flushed at most once per
 *     `requestAnimationFrame` — a burst of WS messages within one frame
 *     collapses to a single store mutation + a single notify.
 *   - Reads are exposed three ways:
 *       1. `subscribeSlab` + `getSnapshot` — the `useSyncExternalStore`-
 *          compatible pair `useLivePrice()` uses. `getSnapshot` returns a
 *          referentially STABLE object when nothing changed (required for
 *          correct `useSyncExternalStore` behaviour — React uses `Object.is`
 *          to decide whether a re-render is needed).
 *       2. `getLivePriceSnapshot` — a plain, NON-reactive read with no
 *          subscription side effect at all. Exists specifically so
 *          `useTrade`/`useClosePosition` (which need the current price only
 *          *inside* their submit-time async callback, never for JSX) don't
 *          have to call the reactive `useLivePrice()` hook — see BUILD-LOG
 *          Phase 0 finding #3: that reactive call was forcing every caller
 *          of `useTrade()`/`useClosePosition()` (i.e. the Phase 4
 *          `OrderTicket`) to re-render on every tick, no matter how good the
 *          store itself is. This is a price/data-plumbing change, not an
 *          on-chain logic change — the tx-building code is untouched.
 *       3. `subscribeSlab` used directly (bypassing `useSyncExternalStore`
 *          and React state entirely) — this is the chart's read path
 *          (Phase 2): call `series.update()` from inside the raw callback.
 */

import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import { getBackendUrl } from "@/lib/config";
import { startPerfSpan } from "@/lib/perf/perfTiming";
import { getWsManager } from "./wsManager";

export interface PriceState {
  price: number | null;
  /** Alias for `price` — backward compat with every existing call site. */
  priceUsd: number | null;
  priceE6: bigint | null;
  change24h: number | null;
  high24h: number | null;
  low24h: number | null;
  loading: boolean;
}

/** Shared frozen empty state — same object reference every time, so
 *  `useSyncExternalStore`'s `Object.is` check is trivially satisfied for
 *  slabs with no data yet (and for `getServerSnapshot`, avoiding a
 *  hydration mismatch). */
export const EMPTY_PRICE_STATE: PriceState = Object.freeze({
  price: null,
  priceUsd: null,
  priceE6: null,
  change24h: null,
  high24h: null,
  low24h: null,
  loading: true,
});

/* ── WS URL resolution — ported verbatim from the pre-refactor useLivePrice.ts ──
 * SECURITY REVIEW (mainnet, carried over): the WS price feed sends no auth
 * token. If WS_AUTH_REQUIRED=false server-side (current default per
 * SECURITY.md), any caller can open unauthenticated connections and
 * enumerate active markets; per-IP connection limits are the only defense.
 * If WS_AUTH_REQUIRED=true, this client fails to authenticate and silently
 * falls back to REST seeding — decide before mainnet whether the feed is
 * intentionally public or needs HMAC tokens matching SECURITY.md. */
function getWsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit !== undefined) return explicit;
  try {
    const apiUrl = getBackendUrl();
    return apiUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  } catch {
    return "";
  }
}
const WS_URL = getWsUrl();
let warnedNoUrl = false;

/* ── Per-slab store entries ── */

type SeedSource = "seed-db" | "seed-onchain" | "live" | null;

interface SlabEntry {
  snapshot: PriceState;
  listeners: Set<() => void>;
  releaseWs: (() => void) | null;
  releaseMsg: (() => void) | null;
  /** Buffered-but-not-yet-flushed tick, applied on the next animation frame. */
  pendingTick: { priceE6: bigint; usd: number } | null;
  flushScheduled: boolean;
  /** perf-span finish callback for the currently-buffered tick batch (Phase 0 harness). */
  pendingSpanFinish: (() => void) | null;
  invert: number | undefined;
  source: SeedSource;
  /** Raw (pre-invert) e6 from the last DB seed — kept so a later invert-flag
   *  arrival can retroactively correct an out-of-order DB seed (see
   *  `setInvertFlag`). Only DB seeds need this: on-chain seeds resolve
   *  invert atomically inside `resolveMarketPriceE6`, and live WS ticks
   *  read `entry.invert` fresh on every message. */
  lastDbRawE6: bigint | null;
  /** Wall-clock ms of the last applied LIVE WS tick — lets `applyOnChainPoll`
   *  distinguish "feed is streaming, don't touch" from "feed went quiet /
   *  never covered this market, poll data is the freshest we have". */
  lastLiveTickAt: number;
}

const entries = new Map<string, SlabEntry>();

function getOrCreateEntry(slab: string): SlabEntry {
  let entry = entries.get(slab);
  if (!entry) {
    entry = {
      snapshot: EMPTY_PRICE_STATE,
      listeners: new Set(),
      releaseWs: null,
      releaseMsg: null,
      pendingTick: null,
      flushScheduled: false,
      pendingSpanFinish: null,
      invert: undefined,
      source: null,
      lastDbRawE6: null,
      lastLiveTickAt: 0,
    };
    entries.set(slab, entry);
  }
  return entry;
}

function notify(entry: SlabEntry): void {
  for (const l of entry.listeners) l();
}

/** Shallow-merge + shallow-equality bail-out, so redundant seeds (e.g. two
 *  simultaneously-mounted hook instances both seeding identical REST data —
 *  see Phase 0 finding #2, mobile+desktop both mount) never cause a
 *  spurious notify, and so `getSnapshot` keeps returning the SAME reference
 *  when nothing actually changed (required for `useSyncExternalStore`). */
function applyPatch(entry: SlabEntry, patch: Partial<PriceState>): void {
  const prev = entry.snapshot;
  const next: PriceState = { ...prev, ...patch };
  let changed = false;
  for (const k of Object.keys(next) as (keyof PriceState)[]) {
    if (next[k] !== prev[k]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  entry.snapshot = next;
  notify(entry);
}

function flushEntry(entry: SlabEntry): void {
  entry.flushScheduled = false;
  const tick = entry.pendingTick;
  entry.pendingTick = null;
  if (tick) {
    entry.source = "live";
    entry.lastLiveTickAt = Date.now();
    const prevHigh = entry.snapshot.high24h;
    const prevLow = entry.snapshot.low24h;
    applyPatch(entry, {
      price: tick.usd,
      priceUsd: tick.usd,
      priceE6: tick.priceE6,
      high24h: prevHigh !== null ? Math.max(prevHigh, tick.usd) : prevHigh,
      low24h: prevLow !== null ? Math.min(prevLow, tick.usd) : prevLow,
      loading: false,
    });
  }
  const finishSpan = entry.pendingSpanFinish;
  entry.pendingSpanFinish = null;
  finishSpan?.();
}

function scheduleFlush(entry: SlabEntry): void {
  if (entry.flushScheduled) return;
  entry.flushScheduled = true;
  requestAnimationFrame(() => flushEntry(entry));
}

// When a tab is backgrounded, requestAnimationFrame is paused/throttled — a tick
// that arrives while hidden buffers into `pendingTick` but its scheduled rAF
// callback doesn't run, so the price looks frozen and the user "has to refresh".
// Flush any pending ticks the instant the tab becomes visible again so the
// displayed price is current on return, without waiting for the next rAF+tick.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const entry of entries.values()) {
      if (entry.pendingTick) flushEntry(entry);
    }
  });
}

function handleRawMessage(slab: string, entry: SlabEntry, data: unknown): void {
  if (typeof data !== "object" || data === null) return;
  const msg = data as {
    type?: string;
    // Current server format (flushPriceUpdate in percolator-api/src/routes/ws.ts)
    slab?: string;
    price?: number;
    // Legacy format (kept for compatibility, same as pre-refactor client)
    slabAddress?: string;
    data?: { priceE6?: string };
  };

  const isCurrentServer =
    (msg.type === "price" || msg.type === "price.updated") &&
    msg.slab === slab &&
    typeof msg.price === "number" &&
    msg.price > 0;
  const isLegacy =
    (msg.type === "price" || msg.type === "price.updated") &&
    msg.slabAddress === slab &&
    msg.data?.priceE6 != null;

  let rawE6: bigint | null = null;
  if (isCurrentServer) {
    rawE6 = BigInt(Math.round(msg.price! * 1_000_000));
  } else if (isLegacy) {
    const priceStr = msg.data!.priceE6!;
    if (typeof priceStr === "string" && /^-?\d+$/.test(priceStr)) {
      rawE6 = BigInt(priceStr);
    } else {
      console.warn("[priceStore] Invalid legacy priceE6 format from WebSocket:", priceStr);
    }
  }
  if (rawE6 === null) return;

  const e6 = sanitizePriceE6(applyInvert(rawE6, entry.invert));
  if (e6 === 0n) return; // reject corrupt/out-of-band WS prices, same guard as pre-refactor
  const usd = Number(e6) / 1_000_000;

  if (!entry.pendingTick) {
    entry.pendingSpanFinish = startPerfSpan("price-push-to-paint");
  }
  entry.pendingTick = { priceE6: e6, usd };
  scheduleFlush(entry);
}

/* ── Public: reactive (useSyncExternalStore) surface ── */

/**
 * Subscribe to live updates for a slab. Opens the shared WS connection (via
 * wsManager) on the FIRST listener for this slab, refcounts subsequent
 * listeners, and releases (with the manager's own teardown delay) once the
 * LAST listener unsubscribes. Also usable directly (bypassing
 * `useSyncExternalStore`) as the chart's raw tick feed — see Phase 2.
 */
export function subscribeSlab(slab: string, onStoreChange: () => void): () => void {
  const entry = getOrCreateEntry(slab);
  entry.listeners.add(onStoreChange);

  if (!entry.releaseWs) {
    if (!WS_URL && typeof window !== "undefined" && !warnedNoUrl) {
      warnedNoUrl = true;
      console.warn(
        "[priceStore] No WebSocket URL configured — live price streaming disabled, falling back to REST/on-chain seed only. Set NEXT_PUBLIC_WS_URL.",
      );
    }
    const manager = getWsManager(WS_URL);
    entry.releaseWs = manager.subscribeChannel(slab);
    entry.releaseMsg = manager.onMessage((data) => handleRawMessage(slab, entry, data));
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.listeners.delete(onStoreChange);
    if (entry.listeners.size === 0) {
      entry.releaseWs?.();
      entry.releaseMsg?.();
      entry.releaseWs = null;
      entry.releaseMsg = null;
      // The last-known snapshot is intentionally kept cached in `entries` —
      // a quick remount / market-switch-back doesn't flash back to loading.
    }
  };
}

export function getSnapshot(slab: string | null): PriceState {
  if (!slab) return EMPTY_PRICE_STATE;
  return entries.get(slab)?.snapshot ?? EMPTY_PRICE_STATE;
}

export function getServerSnapshot(): PriceState {
  return EMPTY_PRICE_STATE;
}

/* ── Public: non-reactive snapshot — for useTrade/useClosePosition, see file doc ── */

/** Identical data to `getSnapshot`, exported under its own name so call
 *  sites that intentionally want a non-subscribing read are self-documenting. */
export function getLivePriceSnapshot(slab: string | null): PriceState {
  return getSnapshot(slab);
}

/* ── Public: seed paths (REST cold-start fallback, on-chain fallback, invert-flag sync) ── */

/**
 * Track the current invert flag for a slab. Also retroactively corrects a
 * DB-sourced seed that was computed before the real invert flag was known
 * (mirrors the pre-refactor "CR fix" in the old useLivePrice.ts: DB price
 * can arrive before mktConfig). Only DB seeds need this — on-chain seeds
 * resolve invert atomically inside `resolveMarketPriceE6`, and live WS
 * ticks read `entry.invert` fresh on every message, so they're never stale.
 */
export function setInvertFlag(slab: string, invert: number | undefined): void {
  const entry = getOrCreateEntry(slab);
  const changed = entry.invert !== invert;
  entry.invert = invert;
  if (changed && entry.source === "seed-db" && entry.lastDbRawE6 !== null) {
    const e6 = applyInvert(entry.lastDbRawE6, invert);
    const usd = e6 > 0n ? Number(e6) / 1_000_000 : entry.snapshot.priceUsd ?? 0;
    applyPatch(entry, { price: usd, priceUsd: usd, priceE6: e6 });
  }
}

/**
 * DB `last_price` cold-start fallback. Unlike the pre-refactor version
 * (which re-applied this unconditionally on every 10s REST poll — a real
 * bug: it would overwrite a fresher live WS price back to a stale DB value
 * whenever they didn't match to the last digit), this is **only-if-empty**:
 * once any real data exists (WS, on-chain, or an earlier DB seed), later
 * calls are no-ops for the price fields. The raw e6 is still remembered
 * every call so a later invert-flag correction (see `setInvertFlag`) can
 * still fire correctly.
 */
export function seedFromDbIfEmpty(slab: string, dbPrice: number, invert: number | undefined): void {
  if (dbPrice <= 0) return;
  const entry = getOrCreateEntry(slab);
  const rawE6 = BigInt(Math.round(dbPrice * 1_000_000));
  entry.lastDbRawE6 = rawE6;
  if (entry.snapshot.price !== null) return; // real data already present — never clobber it
  const e6 = applyInvert(rawE6, invert);
  const usd = e6 > 0n ? Number(e6) / 1_000_000 : dbPrice;
  entry.source = "seed-db";
  applyPatch(entry, { price: usd, priceUsd: usd, priceE6: e6, loading: false });
}

/** How long the live WS feed may go silent on a slab before a recurring
 *  on-chain poll is allowed to update its price. Live ticks arrive
 *  sub-second when a feed exists, so 10s of silence means the feed is down,
 *  reconnecting, or never covered this market. */
const LIVE_TICK_STALE_MS = 10_000;

/**
 * Recurring on-chain poll update (PositionsBar's ≤4s freshness floor for
 * markets the WS feed isn't covering). Unlike `seedFromOnChain` (one-shot,
 * only-if-empty), this MAY overwrite an existing price — but never a live
 * one: it applies only when the slab has no live WS tick in the last
 * `LIVE_TICK_STALE_MS`, so a streaming feed always outranks the poll and
 * the flicker-to-stale-price bug `seedFromDbIfEmpty`'s doc describes can't
 * come back through this path.
 *
 * Expects an already-sanitized post-invert e6 price (callers read
 * `wrapperConfigV17.markEwmaE6` via `sanitizePriceE6`, exactly the value
 * `usePortfolio` publishes as `oraclePriceE6`).
 */
export function applyOnChainPoll(slab: string, onChainE6: bigint): void {
  if (onChainE6 <= 0n) return;
  const entry = getOrCreateEntry(slab);
  if (entry.source === "live" && Date.now() - entry.lastLiveTickAt < LIVE_TICK_STALE_MS) return;
  const usd = Number(onChainE6) / 1_000_000;
  if (entry.source === null) entry.source = "seed-onchain";
  applyPatch(entry, { price: usd, priceUsd: usd, priceE6: onChainE6, loading: false });
}

/** On-chain oracle fallback — only-if-empty, same semantics as the pre-refactor hook. */
export function seedFromOnChain(slab: string, onChainE6: bigint): void {
  if (onChainE6 <= 0n) return;
  const entry = getOrCreateEntry(slab);
  if (entry.snapshot.price !== null) return;
  const usd = Number(onChainE6) / 1_000_000;
  entry.source = entry.source ?? "seed-onchain";
  applyPatch(entry, { price: usd, priceUsd: usd, priceE6: onChainE6, loading: false });
}

/** 24h stats (change/high/low) — legitimately-recurring aggregate data, always overwrites. */
export function setStats24h(
  slab: string,
  patch: { change24h?: number | null; high24h?: number | null; low24h?: number | null },
): void {
  const entry = getOrCreateEntry(slab);
  applyPatch(entry, patch);
}
