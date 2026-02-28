"use client";

import { useMemo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignTransaction } from "@privy-io/react-auth/solana";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getConfig, getNetwork, getWsEndpoint } from "@/lib/config";
import { usePrivyAvailable } from "@/hooks/usePrivySafe";
import { usePreferredWallet, resolveActiveWallet } from "@/hooks/usePreferredWallet";
import { getBatchRpc } from "@/lib/batchRpc";

/**
 * Compatibility hook that provides the same interface as @solana/wallet-adapter-react's
 * useWallet() + useConnection(), backed by Privy.
 *
 * When Privy is not available (no app ID or init failure), returns safe defaults
 * so the app runs in read-only mode without crashing.
 */
export function useWalletCompat() {
  const privyAvailable = usePrivyAvailable();

  if (!privyAvailable) {
    return {
      publicKey: null,
      connected: false,
      connecting: false,
      wallet: null,
      signTransaction: undefined,
      disconnect: async () => {},
    };
  }

  return useWalletCompatInner();
}

/**
 * Inner hook that calls Privy hooks. Only called when PrivyProvider is mounted.
 */
function useWalletCompatInner() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction: privySignTransaction } = useSignTransaction();
  const { preferredAddress } = usePreferredWallet();

  const activeWallet = useMemo(() => {
    return resolveActiveWallet(wallets, preferredAddress);
  }, [wallets, preferredAddress]);

  const publicKey = useMemo(() => {
    if (!activeWallet) return null;
    try {
      return new PublicKey(activeWallet.address);
    } catch {
      return null;
    }
  }, [activeWallet]);

  const connected = authenticated && !!activeWallet;

  const signTransaction = useMemo(() => {
    if (!activeWallet) return undefined;
    return async (tx: Transaction): Promise<Transaction> => {
      // Serialize the transaction to bytes for Privy
      const serialized = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      // Explicitly pass the chain so Privy uses the correct network's RPC.
      // Without this, Privy defaults to solana:mainnet which causes 403s
      // when the app is configured for devnet.
      const network = getNetwork();
      const chain = network === "mainnet" ? "solana:mainnet" : "solana:devnet";
      const result = await privySignTransaction({
        transaction: new Uint8Array(serialized),
        wallet: activeWallet,
        chain: chain as any, // SolanaChain type from Privy
      });
      return Transaction.from(Buffer.from(result.signedTransaction));
    };
  }, [activeWallet, privySignTransaction]);

  return {
    publicKey,
    connected,
    connecting: !ready,
    wallet: activeWallet,
    signTransaction,
    disconnect: logout,
  };
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
      ...(wsEndpoint ? { wsEndpoint } : {}),
      // Disable web3.js built-in retry — our batch transport handles retries
      // with proper exponential backoff instead of flat 500ms delays
      ...(isClient ? { disableRetryOnRateLimit: true } : {}),
      // Custom fetch that batches multiple RPC calls into single HTTP requests
      ...(fetchOption ? { fetch: fetchOption as any } : {}),
    });
  }, []);

  return { connection };
}
