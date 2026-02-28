"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";
import { resolveMarketPriceE6, sanitizePriceE6 } from "@/lib/oraclePrice";

// Derive WebSocket URL from API URL: https://... → wss://...
function getWsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) return explicit;
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? process.env.NEXT_PUBLIC_BACKEND_URL ?? "";
  if (!apiUrl) return "";
  return apiUrl.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
}
const WS_URL = getWsUrl();
if (!WS_URL && typeof window !== "undefined") {
  console.warn("[useLivePrice] No API URL configured — WebSocket price streaming disabled. Set NEXT_PUBLIC_API_URL.");
}
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

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
  const mint = mktConfig?.collateralMint?.toBase58() ?? null;

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

  useEffect(() => {
    mountedRef.current = true;
    // Only set loading if we don't already have a price
    setState((prev) => prev.price !== null ? prev : { ...prev, loading: true });

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
            stale.onopen = () => { try { stale.close(); } catch { /* ignore */ } };
            stale.onerror = () => {};
            stale.onmessage = () => {};
          }
        } catch { /* ignore */ }
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
          const msg = JSON.parse(event.data as string) as {
            type: string;
            slabAddress?: string;
            data?: { priceE6?: string; source?: string };
            timestamp?: number;
          };

          if (msg.type === "price.updated" && msg.slabAddress === slabAddr && msg.data?.priceE6) {
            // C4: Validate string format before BigInt conversion
            const priceStr = msg.data.priceE6;
            if (typeof priceStr !== "string" || !/^-?\d+$/.test(priceStr)) {
              console.warn("Invalid price format from WebSocket:", priceStr);
              return;
            }
            const rawE6 = BigInt(priceStr);
            const e6 = sanitizePriceE6(rawE6);
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
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, RECONNECT_MAX_MS);
        connect();
      }, reconnectDelay.current);
    }

    connect();

    // Also fetch 24h stats via REST — use Next.js proxy to avoid CORS issues
    if (slabAddr) {
      fetch(`/api/prices/${slabAddr}`)
        .then((r) => { if (!r.ok) throw new Error("not found"); return r.json(); })
        .then((json: { stats?: { change24h?: number; high24h?: string; low24h?: string } }) => {
          if (json.stats && mountedRef.current) {
            setState((prev) => ({
              ...prev,
              change24h: json.stats?.change24h ?? null,
              high24h: json.stats?.high24h ? Number(json.stats.high24h) / 1_000_000 : null,
              low24h: json.stats?.low24h ? Number(json.stats.low24h) / 1_000_000 : null,
            }));
          }
        })
        .catch(() => {});
    }

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
            sock.onopen = () => { try { sock.close(); } catch { /* ignore */ } };
            sock.onerror = () => {};
            sock.onmessage = () => {};
          }
        } catch { /* ignore */ }
      }
    };
  }, [slabAddr]);

  return state;
}
