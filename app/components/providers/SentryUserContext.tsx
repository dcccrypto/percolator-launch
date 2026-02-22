"use client";

import { useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import * as Sentry from "@sentry/nextjs";

/**
 * Sets the Sentry user context based on the connected wallet.
 * This allows filtering Sentry issues by wallet address.
 * Mount this inside the PrivyProvider tree.
 */
export function SentryUserContext() {
  const { authenticated } = usePrivy();
  const { wallets } = useWallets();

  useEffect(() => {
    const wallet = wallets[0];
    if (authenticated && wallet) {
      Sentry.setUser({
        id: wallet.address,
      });
    } else {
      Sentry.setUser(null);
    }
  }, [authenticated, wallets]);

  return null;
}
