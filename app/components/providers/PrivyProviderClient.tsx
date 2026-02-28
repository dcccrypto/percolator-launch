"use client";

import { FC, ReactNode, useMemo } from "react";
import { PrivyProvider, usePrivy, type WalletListEntry } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { getNetwork } from "@/lib/config";
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
  // IMPORTANT: only expose the RPC for the CURRENT network. If both solana:mainnet and
  // solana:devnet are present, Privy defaults to mainnet regardless of app network —
  // causing 403s when the app is on devnet (public mainnet RPC rejects the request).
  const solanaRpcs = useMemo(() => {
    const network = getNetwork(); // reads localStorage override or NEXT_PUBLIC_DEFAULT_NETWORK
    const heliusKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? "";

    // Derive WSS from HTTPS URL by replacing scheme
    const toWss = (url: string) => url.replace(/^https:\/\//, "wss://");

    if (network === "mainnet") {
      const rpcUrl =
        process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
        (heliusKey
          ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
          : "https://api.mainnet-beta.solana.com");
      return {
        "solana:mainnet": {
          rpc: createSolanaRpc(rpcUrl),
          rpcSubscriptions: createSolanaRpcSubscriptions(toWss(rpcUrl)),
          blockExplorerUrl: "https://solscan.io",
        },
      };
    }

    // devnet (default)
    const rpcUrl = heliusKey
      ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}`
      : "https://api.devnet.solana.com";
    return {
      "solana:devnet": {
        rpc: createSolanaRpc(rpcUrl),
        rpcSubscriptions: createSolanaRpcSubscriptions(toWss(rpcUrl)),
        blockExplorerUrl: "https://explorer.solana.com?cluster=devnet",
      },
    };
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
