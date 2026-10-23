"use client";

import { createContext, useCallback, useContext } from "react";

/**
 * Context to indicate whether Privy is available.
 * Set to true by WalletProvider when PrivyProvider is mounted.
 */
export const PrivyAvailableContext = createContext<boolean>(false);

/**
 * Context holding the Privy "connect wallet" action: `login()` when there is no
 * Privy session, `connectWallet()` when there is one but its wallet is gone
 * (see PrivyLoginBridge in PrivyProviderClient.tsx).
 * Provided by WalletProvider when Privy is available.
 */
export const PrivyLoginContext = createContext<(() => void) | null>(null);

/**
 * Context holding a getter for the Privy session headers (access token + identity token), for
 * calling server routes that verify the caller's Privy session (lib/privy-auth.ts). Resolves to
 * null when there is no signed-in Privy session. No wallet prompt: both tokens are the SDK's own.
 * Provided by PrivyLoginBridge; null when Privy is not mounted (plain wallet adapter).
 */
export type PrivySessionHeaders = () => Promise<Record<string, string> | null>;
export const PrivySessionHeadersContext = createContext<PrivySessionHeaders | null>(null);

/**
 * Returns true if PrivyProvider is in the component tree.
 * Components should check this before calling usePrivy() or useWallets().
 */
export function usePrivyAvailable(): boolean {
  return useContext(PrivyAvailableContext);
}

/**
 * Safe hook that returns the Privy connect action, or a no-op if unavailable.
 * Use this instead of `usePrivy().login` in components that need to trigger
 * the wallet connect modal but should work without Privy — `login()` alone
 * silently does nothing while a Privy session exists.
 */
export function usePrivyLogin(): () => void {
  const login = useContext(PrivyLoginContext);
  return useCallback(() => {
    if (login) {
      login();
    } else {
      console.warn("[Privy] Wallet connection unavailable");
    }
  }, [login]);
}

/** The Privy session headers getter, or null when Privy is not mounted. */
export function usePrivySessionHeaders(): PrivySessionHeaders | null {
  return useContext(PrivySessionHeadersContext);
}
