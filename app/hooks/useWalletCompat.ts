"use client";

import { useMemo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignTransaction } from "@privy-io/react-auth/solana";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getConfig } from "@/lib/config";

/**
 * Compatibility hook that provides the same interface as @solana/wallet-adapter-react's
 * useWallet() + useConnection(), backed by Privy.
 *
 * This allows incremental migration — hooks can swap one import line.
 */
export function useWalletCompat() {
  const { ready, authenticated, user, logout } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction: privySignTransaction } = useSignTransaction();

  const activeWallet = useMemo(() => {
    if (!wallets.length) return null;
    // Prefer external wallet, fall back to embedded
    return (
      wallets.find((w) => !w.standardWallet?.name?.toLowerCase().includes("privy")) ||
      wallets[0]
    );
  }, [wallets]);

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
      const result = await privySignTransaction({
        transaction: new Uint8Array(serialized),
        wallet: activeWallet,
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
 */
export function useConnectionCompat() {
  const connection = useMemo(() => {
    const url = getConfig().rpcUrl;
    const rpc =
      !url || !url.startsWith("http")
        ? "https://api.devnet.solana.com"
        : url;
    return new Connection(rpc, "confirmed");
  }, []);

  return { connection };
}
