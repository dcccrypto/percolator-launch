"use client";

import { FC, ReactNode, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import "@solana/wallet-adapter-react-ui/styles.css";
import { AccessibleWalletModalProvider } from "@/components/wallet/AccessibleWalletModalProvider";
import { getConfig } from "@/lib/config";

export const WalletProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const wallets = useMemo(() => [], []);
  const rpcUrl = useMemo(() => {
    const url = getConfig().rpcUrl;
    // Fallback for SSG/build time when env vars may be unavailable
    if (!url || !url.startsWith("http")) return "https://api.devnet.solana.com";
    return url;
  }, []);

  return (
    <ConnectionProvider endpoint={rpcUrl}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <AccessibleWalletModalProvider>{children}</AccessibleWalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
};
