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
  // IMPORTANT: Privy always needs solana:mainnet RPC present — even in devnet mode —
  // otherwise initialization fails with "No RPC configuration found for chain solana:mainnet".
  // We provide BOTH chains so Privy initializes correctly. The correct chain for
  // transactions is selected via the explicit `chain` parameter on signTransaction /
  // signAndSendTransaction calls (see useWalletCompat.ts), NOT by limiting rpcs.
  const solanaRpcs = useMemo(() => {
    const heliusKey = process.env.NEXT_PUBLIC_HELIUS_API_KEY ?? "";

    // Derive WSS from HTTPS URL by replacing scheme
    const toWss = (url: string) => url.replace(/^https:\/\//, "wss://");

    // Mainnet RPC — always provided for Privy initialization
    const mainnetRpcUrl =
      process.env.NEXT_PUBLIC_HELIUS_RPC_URL ||
      (heliusKey
        ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
        : "https://api.mainnet-beta.solana.com");

    // Devnet RPC — always provided for Privy initialization
    const devnetRpcUrl = heliusKey
      ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}`
      : "https://api.devnet.solana.com";

    return {
      "solana:mainnet": {
        rpc: createSolanaRpc(mainnetRpcUrl),
        rpcSubscriptions: createSolanaRpcSubscriptions(toWss(mainnetRpcUrl)),
        blockExplorerUrl: "https://solscan.io",
      },
      "solana:devnet": {
        rpc: createSolanaRpc(devnetRpcUrl),
        rpcSubscriptions: createSolanaRpcSubscriptions(toWss(devnetRpcUrl)),
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
