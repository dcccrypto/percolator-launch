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
    // Priority: explicit RPC URL → build from API key → public fallback (403s on mainnet).
    // NEXT_PUBLIC_HELIUS_API_KEY is already required by the rest of the app, so this
    // resolves correctly in production without needing a separate NEXT_PUBLIC_HELIUS_RPC_URL.
    const heliusKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? "";
    const mainnetUrl =
      process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
      (heliusKey
        ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
        : "https://api.mainnet-beta.solana.com"); // last resort — rate-limited
    const devnetUrl =
      heliusKey
        ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}`
        : "https://api.devnet.solana.com";

    // Derive WSS from HTTPS URL by replacing scheme
    const toWss = (url: string) => url.replace(/^https:\/\//, "wss://");

    return {
      "solana:mainnet": {
        rpc: createSolanaRpc(mainnetUrl),
        rpcSubscriptions: createSolanaRpcSubscriptions(toWss(mainnetUrl)),
        blockExplorerUrl: "https://solscan.io",
      },
      "solana:devnet": {
        rpc: createSolanaRpc(devnetUrl),
        rpcSubscriptions: createSolanaRpcSubscriptions(toWss(devnetUrl)),
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
