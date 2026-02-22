"use client";

import { FC, ReactNode, useMemo } from "react";
import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { SentryUserContext } from "@/components/providers/SentryUserContext";
import { getConfig } from "@/lib/config";

export const WalletProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const rpcUrl = useMemo(() => {
    const url = getConfig().rpcUrl;
    if (!url || !url.startsWith("http")) return "https://api.devnet.solana.com";
    return url;
  }, []);

  const solanaConnectors = useMemo(() => toSolanaWalletConnectors(), []);

  // Fall back to a placeholder in test/CI environments where the secret is not set.
  // Privy will still refuse connections but the server will start without crashing.
  const privyAppId =
    process.env.NEXT_PUBLIC_PRIVY_APP_ID ||
    "clxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        appearance: {
          walletChainType: "solana-only",
          showWalletLoginFirst: true,
        },
        loginMethods: ["wallet", "email"],
        externalWallets: {
          solana: {
            connectors: solanaConnectors,
          },
        },
        embeddedWallets: {
          solana: {
            createOnLogin: "users-without-wallets",
          },
        },
      }}
    >
      <SentryUserContext />
      {children}
    </PrivyProvider>
  );
};
