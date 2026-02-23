"use client";

import { createContext, useCallback, useContext } from "react";

/**
 * Context to indicate whether Privy is available.
 * Set to true by WalletProvider when PrivyProvider is mounted.
 */
export const PrivyAvailableContext = createContext<boolean>(false);

/**
 * Context holding Privy's login function.
 * Provided by WalletProvider when Privy is available.
 */
export const PrivyLoginContext = createContext<(() => void) | null>(null);

/**
 * Returns true if PrivyProvider is in the component tree.
 * Components should check this before calling usePrivy() or useWallets().
 */
export function usePrivyAvailable(): boolean {
  return useContext(PrivyAvailableContext);
}

/**
 * Safe hook that returns Privy's login function, or a no-op if unavailable.
 * Use this instead of `usePrivy().login` in components that need to trigger
 * the wallet connect modal but should work without Privy.
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
