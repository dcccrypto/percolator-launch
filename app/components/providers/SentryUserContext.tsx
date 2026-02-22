"use client";

import { useEffect } from "react";
import { useWalletCompat as useWallet } from "@/hooks/useWalletCompat";
import * as Sentry from "@sentry/nextjs";

/**
 * Sets the Sentry user context based on the connected wallet.
 * This allows filtering Sentry issues by wallet address.
 * Mount this inside the WalletProvider tree.
 */
export function SentryUserContext() {
  const { publicKey, connected } = useWallet();

  useEffect(() => {
    if (connected && publicKey) {
      Sentry.setUser({
        id: publicKey.toBase58(),
        // Don't send PII — wallet address is pseudonymous
      });
    } else {
      // Clear user context when wallet disconnects
      Sentry.setUser(null);
    }
  }, [connected, publicKey]);

  return null;
}
