"use client";

import { useContext, useMemo } from "react";
import { Connection } from "@solana/web3.js";
import { getConfig, getWsEndpoint } from "@/lib/config";
import { WalletApiContext } from "@/hooks/walletApiContext";
import { getBatchRpc } from "@/lib/batchRpc";

/**
 * Compatibility hook that provides the same interface as
 * @solana/wallet-adapter-react's `useWallet()`, backed by Privy (primary) or
 * wallet-adapter (fallback).
 *
 * The actual wallet logic now lives in the provider bridges
 * (`PrivyProviderClient` / `WalletAdapterProviderClient`), which each compute a
 * `WalletApi` and inject it through `WalletApiContext`. This hook is a pure
 * context read — it imports NO wallet SDK, so its 60+ call sites no longer drag
 * `@privy-io/react-auth` (and its transitive WalletConnect/Coinbase/viem graph)
 * into the shared client bundle. Privy is loaded only when its provider mounts,
 * as a separate async chunk, off the initial critical path.
 *
 * Resolution (decided by which provider is mounted, see WalletProvider):
 *   1. Privy — when NEXT_PUBLIC_PRIVY_APP_ID is set (PrivyProviderClient mounted).
 *   2. Wallet-adapter — when Privy is absent (WalletAdapterProviderClient mounted).
 *   3. Read-only defaults — no provider mounted (context default).
 */
export function useWalletCompat() {
  return useContext(WalletApiContext);
}

/**
 * Compatibility hook replacing useConnection() from wallet-adapter.
 * Returns a Connection object using the app's configured RPC URL.
 *
 * Uses batching RPC transport on the client to coalesce individual JSON-RPC
 * calls into batch requests, reducing HTTP request count by 10-30x and
 * preventing 429 rate limit errors. See lib/batchRpc.ts for details.
 */
export function useConnectionCompat() {
  const connection = useMemo(() => {
    const url = getConfig().rpcUrl;
    const wsEndpoint = getWsEndpoint();

    // On the client, use batching fetch to coalesce RPC calls
    const isClient = typeof window !== "undefined";
    const fetchOption = isClient ? getBatchRpc().batchFetch : undefined;

    return new Connection(url, {
      commitment: "confirmed",
      // #869: Always pass wsEndpoint explicitly — omitting it lets @solana/web3.js
      // auto-derive wss:// from the HTTP proxy URL, causing reconnect storms on Vercel.
      // getWsEndpoint() always returns a valid WSS URL (Helius if configured,
      // otherwise public Solana WS endpoint for the current network).
      wsEndpoint,
      // Disable web3.js built-in retry — our batch transport handles retries
      // with proper exponential backoff instead of flat 500ms delays
      ...(isClient ? { disableRetryOnRateLimit: true } : {}),
      // Custom fetch that batches multiple RPC calls into single HTTP requests
      ...(fetchOption ? { fetch: fetchOption as any } : {}),
    });
  }, []);

  return { connection };
}
