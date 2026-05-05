"use client";

/**
 * Live price + 24h stats for the active slab (SlabProvider).
 *
 * Request budget (Prompt 77 / 84):
 * - **REST:** `GET /api/prices/:slab` and `GET /api/markets/:slab` are loaded via **SWR**
 *   with the URL as the cache key. Every mounted consumer shares **one in-flight request
 *   per key** (see `dedupingInterval`). Before this change, each `useLivePrice()` call
 *   issued its own parallel pair of fetches → **2×N** HTTP requests for N subscribers.
 * - **WebSocket:** still **one connection per subscriber** today (Prompt 93 may consolidate).
 * - **React Strict Mode (dev):** effects can mount twice; SWR still dedupes rapid duplicate
 *   subscriptions, but you may occasionally see two requests if the gap exceeds deduping.
 */

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { useSlabState } from "@/components/providers/SlabProvider";
import { applyInvert, resolveMarketPriceE6, sanitizePriceE6 } from "@/lib/oraclePrice";
import { getBackendUrl } from "@/lib/config";

// ── SECURITY REVIEW (mainnet) ─────────────────────────────────────────────
// The WS price feed client sends NO authentication token when connecting.
// If WS_AUTH_REQUIRED=false on the server (current default per SECURITY.md),
// any external caller can open unauthenticated connections, subscribe to any
// slab's live prices, and enumerate active markets. Per-IP connection limits
// (default 5) are the only protection against abuse.
//
// If WS_AUTH_REQUIRED=true on the server, this client will fail to
// authenticate and silently fall back to 30s REST polling — the WS feature
// becomes a no-op with no user-visible indication.
//
// Before mainnet: decide whether the price feed is intentionally public
// (document it, set aggressive per-IP limits) or requires auth (implement
// HMAC token generation here matching the scheme in SECURITY.md).
// ──────────────────────────────────────────────────────────────────────────

// Derive WebSocket URL from API URL: https://... → wss://...
function getWsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;
  // Use getBackendUrl() which has the Railway production fallback,
  // instead of reading env vars directly (which returns "" in production
  // when NEXT_PUBLIC_API_URL is not explicitly set).
  try {
    const apiUrl = getBackendUrl();
    return apiUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  } catch {
    return "";
  }
}
const WS_URL = getWsUrl();
if (!WS_URL && typeof window !== "undefined") {
  console.warn("[useLivePrice] No API URL configured — WebSocket price streaming disabled. Set NEXT_PUBLIC_API_URL.");
}
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
// Jitter: randomise within ±25% of the computed delay to prevent thundering-herd
// reconnects when the Railway API recovers and hundreds of clients retry in unison.
const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);

/** SWR fetcher: fail fast on HTTP error (same as previous inline fetch + catch). */
async function livePriceJsonFetcher<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

const SWR_REST_OPTS = {
  dedupingInterval: 10_000,
  refreshInterval: 10_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const;

interface PriceState {
  price: number | null;
  /** Alias for `price` — backward compat */
  priceUsd: number | null;
  priceE6: bigint | null;
  change24h: number | null;
  high24h: number | null;
  low24h: number | null;
  loading: boolean;
}

type PricesApiJson = {
  stats?: { change24h?: number; high24h?: string; low24h?: string } | null;
};
type MarketApiJson = { market?: { last_price?: number | null } };

/**
 * Real-time price hook — connects to the Percolator WebSocket price engine.
 * Falls back to on-chain oracle price from SlabProvider if WebSocket is unavailable.
 *
 * Gets the slab address from SlabProvider context (not query params)
 * so it works on both /trade/[slab] and ?market= routes.
 *
 */
export function useLivePrice(): PriceState {
  const [state, setState] = useState<PriceState>({
    price: null,
    priceUsd: null,
    priceE6: null,
    change24h: null,
    high24h: null,
    low24h: null,
    loading: true,
  });

  const { config: mktConfig, slabAddress } = useSlabState();
  // Use the slab address from SlabProvider context — works for both /trade/[slab] and ?market= URLs
  const slabAddr = slabAddress || null;

  const pricesKey = slabAddr ? `/api/prices/${slabAddr}` : null;
  const { data: pricesJson } = useSWR<PricesApiJson>(pricesKey, livePriceJsonFetcher, SWR_REST_OPTS);

  const marketKey = slabAddr ? `/api/markets/${slabAddr}` : null;
  const { data: marketJson } = useSWR<MarketApiJson>(marketKey, livePriceJsonFetcher, SWR_REST_OPTS);

  // Merge 24h stats from deduped REST
  useEffect(() => {
    if (!pricesJson?.stats) return;
    setState((prev) => ({
      ...prev,
      change24h: pricesJson.stats?.change24h ?? null,
      high24h: pricesJson.stats?.high24h ? Number(pricesJson.stats.high24h) / 1_000_000 : null,
      low24h: pricesJson.stats?.low24h ? Number(pricesJson.stats.low24h) / 1_000_000 : null,
    }));
  }, [pricesJson]);

  // PERC-1232: DB last_price display-only fallback (deduped REST)
  // GH#1990: The DB stores raw (non-inverted) oracle price. For inverted markets
  // (config.invert === 1), apply applyInvert so priceE6 is in the same domain as
  // entryPrice (which is stored post-inversion on-chain). Without this, PnL and
  // liquidation price calculations are directionally wrong for inverted markets.
  //
  // CR fix: track dbRawE6 separately so re-runs recompute when mktConfig?.invert
  // arrives after the initial render (avoids stale invert on first DB-fallback paint).
  const dbRawE6Ref = useRef<bigint | null>(null);
  useEffect(() => {
    const dbPrice = marketJson?.market?.last_price;
    if (dbPrice == null || dbPrice <= 0) return;
    // Always update rawE6 so subsequent invert-change re-runs recompute correctly.
    const rawE6 = BigInt(Math.round(dbPrice * 1_000_000));
    dbRawE6Ref.current = rawE6;
    setState((prev) => {
      // Recompute from stored rawE6 when:
      // 1. No live price has been received yet (initial DB fallback), OR
      // 2. The invert flag changed after the initial paint (race: DB price
      //    arrived before mktConfig). Without this, inverted markets show
      //    the raw (non-inverted) price until a WebSocket update arrives.
      const e6 = applyInvert(rawE6, mktConfig?.invert);
      const usd = e6 > 0n ? Number(e6) / 1_000_000 : dbPrice;
      if (prev.price !== null && prev.priceE6 === e6) {
        // Price already correct — no update needed
        return prev;
      }
      return { ...prev, price: usd, priceUsd: usd, priceE6: e6, loading: false };
    });
  }, [marketJson, mktConfig?.invert]);

  // Seed from on-chain slab data when no live price yet
  useEffect(() => {
    if (!mktConfig) return;
    // Use oracle-mode-aware price resolution (handles pyth-pinned, hyperp, and admin modes)
    // resolveMarketPriceE6 now includes sanitization (rejects values > MAX_ORACLE_PRICE)
    const onChainE6 = resolveMarketPriceE6(mktConfig);
    if (onChainE6 === 0n) return;
    const usd = Number(onChainE6) / 1_000_000;
    setState((prev) => {
      if (prev.price !== null) return prev;
      return { ...prev, price: usd, priceUsd: usd, priceE6: onChainE6, loading: false };
    });
  }, [mktConfig]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mountedRef = useRef(true);
  const wsConnected = useRef(false);
  // CR fix (GH#1990): keep invert flag in a ref so the WS onmessage closure always
  // reads the latest value without requiring a reconnect each time mktConfig changes.
  const invertRef = useRef<number | undefined>(mktConfig?.invert);
  // Keep invertRef in sync whenever mktConfig changes (no reconnect needed).
  useEffect(() => {
    invertRef.current = mktConfig?.invert;
  }, [mktConfig?.invert]);

  useEffect(() => {
    mountedRef.current = true;
    // Only set loading if we don't already have a price
    setState((prev) => (prev.price !== null ? prev : { ...prev, loading: true }));

    if (!slabAddr) return;

    let ws: WebSocket;

    function connect() {
      if (!mountedRef.current) return;
      // Skip WebSocket if URL not configured
      if (!WS_URL) return;
      // Close any existing connection to prevent zombie WS
      if (wsRef.current) {
        try {
          // Suppress "closed before established" warning by only closing OPEN/CLOSING sockets
          if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CLOSING) {
            wsRef.current.close();
          } else {
            // CONNECTING state — attach close-on-open handler to prevent leak
            const stale = wsRef.current;
            stale.onopen = () => {
              try {
                stale.close();
              } catch {
                /* ignore */
              }
            };
            stale.onerror = () => {};
            stale.onmessage = () => {};
          }
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
      try {
        ws = new WebSocket(WS_URL);
        wsRef.current = ws;
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        wsConnected.current = true;
        reconnectDelay.current = RECONNECT_BASE_MS;
        // Subscribe to this market
        ws.send(JSON.stringify({ type: "subscribe", slabAddress: slabAddr }));
      };

      ws.onmessage = (event) => {
        try {
          // GH#1990 / WS schema fix: server sends { type:"price", slab, price (USD float) }
          // Legacy code expected { slabAddress, data.priceE6 } which never matched.
          // Support both the current server format and the legacy format for compatibility.
          const msg = JSON.parse(event.data as string) as {
            type: string;
            // Current server format (flushPriceUpdate in ws.ts)
            slab?: string;
            price?: number;
            // Legacy format (never actually sent by server, kept for future-proofing)
            slabAddress?: string;
            data?: { priceE6?: string; source?: string };
            timestamp?: number;
          };

          const isCurrentServer =
            (msg.type === "price" || msg.type === "price.updated") &&
            msg.slab === slabAddr &&
            typeof msg.price === "number" &&
            msg.price > 0;
          const isLegacy =
            (msg.type === "price" || msg.type === "price.updated") &&
            msg.slabAddress === slabAddr &&
            msg.data?.priceE6 != null;

          if (isCurrentServer) {
            // Server sends price as USD float from raw (non-inverted) priceE6.
            // GH#1990: Apply invert flag so priceE6 is in the same domain as entryPrice.
            // Use invertRef.current (not mktConfig?.invert) to avoid stale closure.
            const rawE6 = BigInt(Math.round(msg.price! * 1_000_000));
            const e6 = sanitizePriceE6(applyInvert(rawE6, invertRef.current));
            if (e6 === 0n) return;
            const usd = Number(e6) / 1_000_000;
            if (mountedRef.current) {
              setState((prev) => ({
                price: usd,
                priceUsd: usd,
                priceE6: e6,
                change24h: prev.change24h,
                high24h: prev.high24h !== null ? Math.max(prev.high24h, usd) : usd,
                low24h: prev.low24h !== null ? Math.min(prev.low24h, usd) : usd,
                loading: false,
              }));
            }
          } else if (isLegacy) {
            // C4: Validate string format before BigInt conversion
            const priceStr = msg.data!.priceE6!;
            if (typeof priceStr !== "string" || !/^-?\d+$/.test(priceStr)) {
              console.warn("Invalid price format from WebSocket:", priceStr);
              return;
            }
            const rawE6 = BigInt(priceStr);
            // GH#1990: Apply invert flag so priceE6 is in the correct domain.
            // Use invertRef.current to avoid stale closure in legacy path too.
            const e6 = sanitizePriceE6(applyInvert(rawE6, invertRef.current));
            if (e6 === 0n) return; // Reject corrupt WS prices
            const usd = Number(e6) / 1_000_000;
            if (mountedRef.current) {
              setState((prev) => ({
                price: usd,
                priceUsd: usd,
                priceE6: e6,
                change24h: prev.change24h,
                high24h: prev.high24h !== null ? Math.max(prev.high24h, usd) : usd,
                low24h: prev.low24h !== null ? Math.min(prev.low24h, usd) : usd,
                loading: false,
              }));
            }
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        wsConnected.current = false;
        if (mountedRef.current) scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose will fire after
      };
    }

    function scheduleReconnect() {
      if (!mountedRef.current) return;
      const delay = jitter(reconnectDelay.current);
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, RECONNECT_MAX_MS);
        connect();
      }, delay);
    }

    connect();

    // M3: Capture slabAddr at subscription time for cleanup
    const capturedSlabAddr = slabAddr;

    return () => {
      mountedRef.current = false;
      wsConnected.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        const sock = wsRef.current;
        wsRef.current = null;
        try {
          if (sock.readyState === WebSocket.OPEN) {
            // Unsubscribe before closing to clean up server-side state
            if (capturedSlabAddr) {
              sock.send(JSON.stringify({ type: "unsubscribe", slabAddress: capturedSlabAddr }));
            }
            sock.close();
          } else if (sock.readyState === WebSocket.CONNECTING) {
            // Not yet open — close once it opens to avoid "closed before established" warning
            sock.onopen = () => {
              try {
                sock.close();
              } catch {
                /* ignore */
              }
            };
            sock.onerror = () => {};
            sock.onmessage = () => {};
          }
        } catch {
          /* ignore */
        }
      }
    };
  }, [slabAddr]);

  return state;
}
