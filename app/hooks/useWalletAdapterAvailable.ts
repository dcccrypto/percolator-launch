"use client";

import { createContext, useContext } from "react";

/**
 * Context to indicate whether @solana/wallet-adapter-react is mounted.
 * Set to true by WalletProvider when no Privy app ID is configured —
 * the wallet-adapter path is used as the fallback for universal wallet connect.
 */
export const WalletAdapterAvailableContext = createContext<boolean>(false);

/**
 * Returns true if the WalletAdapter provider is in the component tree.
 * Components should check this before calling useWallet() from wallet-adapter.
 */
export function useWalletAdapterAvailable(): boolean {
  return useContext(WalletAdapterAvailableContext);
}
