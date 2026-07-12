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
 * The actual wallet logic lives in the provider bridges (`PrivyProviderClient` /
 * `WalletAdapterProviderClient`), which each compute a `WalletApi` and inject it
 * through `WalletApiContext`. This hook is a pure context read — it imports NO
 * wallet SDK, so its 60+ call sites no longer drag `@privy-io/react-auth` (and
 * its transitive WalletConnect/Coinbase/viem graph) into the shared client
 * bundle. Privy loads only when its provider mounts, as a separate async chunk,
 * off the initial critical path. The bridges return memoized WalletApi objects,
 * so consumers that list the wallet in a dep array stay stable.
 */
export function useWalletCompat() {
  return useContext(WalletApiContext);
}

/**
 * Module-level Connection singleton keyed by (rpcUrl, wsEndpoint).
 *
 * Every useConnectionCompat() consumer used to build its OWN Connection (each a
 * potential WS channel); the RPC config is identical for all of them (single
 * network per session), so one shared instance is behavior-identical and
 * collapses the duplication. The batch transport (getBatchRpc) is already a
 * singleton. Rebuilds only if the RPC/WS URL actually changes.
 */
let _sharedConnection: Connection | null = null;
let _sharedConnectionKey = "";

function getSharedConnection(): Connection {
  const url = getConfig().rpcUrl;
  const wsEndpoint = getWsEndpoint();
  const key = `${url}|${wsEndpoint}`;
  if (_sharedConnection && _sharedConnectionKey === key) return _sharedConnection;

  const isClient = typeof window !== "undefined";
  const fetchOption = isClient ? getBatchRpc().batchFetch : undefined;

  _sharedConnection = new Connection(url, {
    commitment: "confirmed",
    // #869: Always pass wsEndpoint explicitly — omitting it lets @solana/web3.js
    // auto-derive wss:// from the HTTP proxy URL, causing reconnect storms on Vercel.
    wsEndpoint,
    // Disable web3.js built-in retry — our batch transport handles retries
    // with proper exponential backoff instead of flat 500ms delays
    ...(isClient ? { disableRetryOnRateLimit: true } : {}),
    // Custom fetch that batches multiple RPC calls into single HTTP requests
    ...(fetchOption ? { fetch: fetchOption as any } : {}),
  });
  _sharedConnectionKey = key;
  return _sharedConnection;
}

/**
 * Compatibility hook replacing useConnection() from wallet-adapter.
 * Returns the shared Connection object (see getSharedConnection).
 */
export function useConnectionCompat() {
  const connection = useMemo(() => getSharedConnection(), []);
  return { connection };
}
