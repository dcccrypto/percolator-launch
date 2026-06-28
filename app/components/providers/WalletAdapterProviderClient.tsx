"use client";

/**
 * WalletAdapterProviderClient
 *
 * Client-only wallet-adapter provider for universal wallet connect (Phantom, Solflare, Backpack,
 * any Wallet Standard compatible browser extension).
 *
 * Mounted by WalletProvider when NEXT_PUBLIC_PRIVY_APP_ID is not set so that anyone
 * can connect a browser wallet without a Privy account.
 *
 * autoConnect: true — re-connects the last used wallet on page load (standard UX).
 */

import { FC, ReactNode, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { getConfig } from "@/lib/config";

interface Props {
  children: ReactNode;
}

export const WalletAdapterProviderClient: FC<Props> = ({ children }) => {
  const endpoint = useMemo(() => {
    return getConfig().rpcUrl || "https://api.devnet.solana.com";
  }, []);

  const wallets = useMemo(
    () => [
      // These are "legacy" adapters that auto-detect the extension. If the user has
      // a Wallet Standard implementation (modern Phantom / Solflare / Backpack) it
      // will be picked up by the WalletProvider via the standard adapter bridge too.
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
    ],
    [],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        {children}
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
};

export default WalletAdapterProviderClient;
