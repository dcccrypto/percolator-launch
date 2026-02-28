"use client";

import { FC, ReactNode, useMemo } from "react";
import { PrivyProvider, usePrivy, type WalletListEntry } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { SentryUserContext } from "@/components/providers/SentryUserContext";
import { PrivyLoginContext } from "@/hooks/usePrivySafe";

/**
 * Client-only Privy provider wrapper. Loaded via next/dynamic with ssr:false
 * to prevent Privy SDK from crashing during server-side rendering.
 */
const PrivyProviderClient: FC<{ appId: string; children: ReactNode }> = ({
  appId,
  children,
}) => {
  const solanaConnectors = useMemo(() => toSolanaWalletConnectors(), []);
  const walletConnectCloudProjectId =
    process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  const walletList = useMemo<WalletListEntry[]>(
    () => ["phantom", "solflare", "backpack", "jupiter", "detected_solana_wallets"],
    []
  );

  // Privy v3 requires explicit Solana RPC config for embedded wallet transactions.
  // Without this, sendTransaction throws "No RPC configuration found for chain solana:mainnet".
  // We configure both mainnet and devnet so the embedded wallet works in all environments.
  const solanaRpcs = useMemo(() => {
    const mainnetUrl =
      process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
      "https://api.mainnet-beta.solana.com";
    // Helius HTTPS RPC URL → WSS (replace scheme); falls back to public Solana WSS
    const mainnetWss = mainnetUrl.startsWith("https://")
      ? mainnetUrl.replace("https://", "wss://")
      : "wss://api.mainnet-beta.solana.com";
    return {
      "solana:mainnet": {
        rpc: createSolanaRpc(mainnetUrl),
        rpcSubscriptions: createSolanaRpcSubscriptions(mainnetWss),
        blockExplorerUrl: "https://solscan.io",
      },
      "solana:devnet": {
        rpc: createSolanaRpc("https://api.devnet.solana.com"),
        rpcSubscriptions: createSolanaRpcSubscriptions(
          "wss://api.devnet.solana.com"
        ),
        blockExplorerUrl: "https://explorer.solana.com?cluster=devnet",
      },
    } as const;
  }, []);

  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          walletChainType: "solana-only",
          showWalletLoginFirst: true,
          walletList,
        },
        loginMethods: ["wallet", "email"],
        walletConnectCloudProjectId,
        externalWallets: {
          solana: {
            connectors: solanaConnectors,
          },
        },
        // Privy v3: solana.rpcs must be at the top-level config.solana key,
        // not inside embeddedWallets.solana. Provides RPC for all Solana standard
        // wallet hooks (useStandardSignAndSendTransaction etc.).
        solana: {
          rpcs: solanaRpcs,
        },
        embeddedWallets: {
          solana: {
            createOnLogin: "users-without-wallets",
          },
        },
      }}
    >
      <SentryUserContext />
      <PrivyLoginBridge>{children}</PrivyLoginBridge>
    </PrivyProvider>
  );
};

/**
 * Bridge that exposes Privy's login function via context so components
 * outside the Privy tree can trigger wallet connection safely.
 */
const PrivyLoginBridge: FC<{ children: ReactNode }> = ({ children }) => {
  const { login } = usePrivy();
  return (
    <PrivyLoginContext.Provider value={login}>
      {children}
    </PrivyLoginContext.Provider>
  );
};

export default PrivyProviderClient;
