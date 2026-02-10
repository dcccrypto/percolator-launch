"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSlabState } from "@/components/providers/SlabProvider";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001";
const WS_URL_IS_DEFAULT = !process.env.NEXT_PUBLIC_WS_URL;
if (WS_URL_IS_DEFAULT && typeof window !== "undefined") {
  console.warn("[useLivePrice] NEXT_PUBLIC_WS_URL not set — falling back to ws://localhost:3001. Set this env var in production.");
}
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const POLL_FALLBACK_MS = 10_000;

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
 * Falls back to Jupiter polling if WebSocket is unavailable.
 *
 * Gets the slab address from SlabProvider context (not query params)
 * so it works on both /trade/[slab] and ?market= routes.
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
    const onChainE6 = mktConfig.authorityPriceE6 ?? mktConfig.lastEffectivePriceE6 ?? 0n;
    if (onChainE6 === 0n) return;
    setState((prev) => {
      if (prev.price !== null) return prev;
      const usd = Number(onChainE6) / 1_000_000;
      return { ...prev, price: usd, priceUsd: usd, priceE6: onChainE6, loading: false };
    });
  }, [mktConfig]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(RECONNECT_BASE_MS);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mountedRef = useRef(true);
  const pollTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  const wsConnected = useRef(false);

  // Jupiter polling fallback
  const pollJupiter = useCallback(async () => {
    if (!mint || wsConnected.current) return;
    try {
      const url = `https://api.jup.ag/price/v2?ids=${mint}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const json = (await resp.json()) as Record<string, unknown>;
      const data = json.data as Record<string, { price?: string }> | undefined;
      if (!data || !data[mint]) return;
      const p = parseFloat(data[mint].price ?? "0");
      if (p > 0 && mountedRef.current) {
        setState((prev) => ({
          ...prev,
          price: p,
          priceUsd: p,
          priceE6: BigInt(Math.round(p * 1_000_000)),
          loading: false,
        }));
      }
    } catch {
      // keep last known
    }
  }, [mint]);

  useEffect(() => {
    mountedRef.current = true;
    setState((prev) => ({ ...prev, loading: true }));

    if (!slabAddr) return;

    let ws: WebSocket;

    function connect() {
      if (!mountedRef.current) return;
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
            const e6 = BigInt(msg.data.priceE6);
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

    // Also fetch 24h stats via REST
    fetch(`${WS_URL.replace("ws://", "http://").replace("wss://", "https://")}/prices/${slabAddr}`)
      .then((r) => r.json())
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

    // Jupiter polling fallback
    pollJupiter();
    pollTimer.current = setInterval(pollJupiter, POLL_FALLBACK_MS);

    return () => {
      mountedRef.current = false;
      wsConnected.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pollTimer.current) clearInterval(pollTimer.current);
      if (wsRef.current) {
        // Unsubscribe before closing to clean up server-side state
        try {
          if (wsRef.current.readyState === WebSocket.OPEN && slabAddr) {
            wsRef.current.send(JSON.stringify({ type: "unsubscribe", slabAddress: slabAddr }));
          }
        } catch { /* ignore */ }
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [slabAddr, pollJupiter]);

  return state;
}
