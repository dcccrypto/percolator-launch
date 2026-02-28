"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";

const STORAGE_KEY = "percolator:preferred-wallet";

interface PreferredWalletContextValue {
  /** The user's manually selected wallet address, or null if using default */
  preferredAddress: string | null;
  /** Set the preferred wallet address. Pass null to clear and revert to default. */
  setPreferredAddress: (address: string | null) => void;
}

export const PreferredWalletContext = createContext<PreferredWalletContextValue>({
  preferredAddress: null,
  setPreferredAddress: () => {},
});

/**
 * Hook to access and set the user's preferred active wallet.
 * The preferred address is persisted in localStorage so it survives page reloads.
 */
export function usePreferredWallet(): PreferredWalletContextValue {
  return useContext(PreferredWalletContext);
}

/**
 * Hook to create the context value for PreferredWalletContext.Provider.
 * Call this once in a provider component.
 */
export function usePreferredWalletState(): PreferredWalletContextValue {
  const [preferredAddress, setPreferredAddressState] = useState<string | null>(null);

  // Hydrate from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setPreferredAddressState(stored);
      }
    } catch {
      // localStorage may be unavailable (SSR, privacy mode)
    }
  }, []);

  const setPreferredAddress = useCallback((address: string | null) => {
    setPreferredAddressState(address);
    try {
      if (address) {
        localStorage.setItem(STORAGE_KEY, address);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // localStorage may be unavailable
    }
  }, []);

  return { preferredAddress, setPreferredAddress };
}

/**
 * Resolve the active wallet from a list using the user's preference.
 * Falls back to the default heuristic (prefer external over embedded)
 * if the preferred wallet is not found in the list.
 */
export function resolveActiveWallet<
  T extends { address: string; standardWallet?: { name?: string } | null },
>(wallets: T[], preferredAddress: string | null): T | null {
  if (!wallets.length) return null;

  // If user has explicitly selected a wallet, use it
  if (preferredAddress) {
    const preferred = wallets.find((w) => w.address === preferredAddress);
    if (preferred) return preferred;
  }

  // Default heuristic: prefer external wallet over Privy embedded
  return (
    wallets.find(
      (w) => !w.standardWallet?.name?.toLowerCase().includes("privy"),
    ) || wallets[0]
  );
}
