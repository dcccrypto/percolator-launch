"use client";

import { Component, FC, ReactNode, useMemo } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { SentryUserContext } from "@/components/providers/SentryUserContext";
import { PrivyAvailableContext, PrivyLoginContext } from "@/hooks/usePrivySafe";
import { getConfig } from "@/lib/config";

/**
 * Error boundary that catches PrivyProvider crashes and renders children
 * without wallet capability. This prevents the entire app from being
 * unusable when Privy SDK fails (invalid app ID, network issues, etc.).
 */
class PrivyErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.warn(
      "[WalletProvider] Privy initialization failed, running in read-only mode:",
      error.message
    );
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

export const WalletProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  // If no Privy app ID is configured, skip PrivyProvider entirely.
  // The app runs in read-only mode (no wallet connection).
  // PrivyAvailableContext = false tells all hooks to return defaults.
  if (!appId) {
    return (
      <PrivyAvailableContext.Provider value={false}>
        {children}
      </PrivyAvailableContext.Provider>
    );
  }

  const readOnlyFallback = (
    <PrivyAvailableContext.Provider value={false}>
      {children}
    </PrivyAvailableContext.Provider>
  );

  return (
    <PrivyErrorBoundary fallback={readOnlyFallback}>
      <PrivyAvailableContext.Provider value={true}>
        <PrivyProviderWrapper appId={appId}>
          {children}
        </PrivyProviderWrapper>
      </PrivyAvailableContext.Provider>
    </PrivyErrorBoundary>
  );
};

/**
 * Inner component that initializes Privy. Separated so the error boundary
 * can catch any errors thrown during PrivyProvider initialization or rendering.
 */
const PrivyProviderWrapper: FC<{ appId: string; children: ReactNode }> = ({
  appId,
  children,
}) => {
  const rpcUrl = useMemo(() => {
    const url = getConfig().rpcUrl;
    if (!url || !url.startsWith("http")) return "https://api.devnet.solana.com";
    return url;
  }, []);

  const solanaConnectors = useMemo(() => toSolanaWalletConnectors(), []);

  return (
    <PrivyProvider
      appId={appId as string}
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
      <PrivyLoginBridge>{children}</PrivyLoginBridge>
    </PrivyProvider>
  );
};

/**
 * Bridge component that exposes Privy's login function via context.
 * Must be rendered inside PrivyProvider.
 */
const PrivyLoginBridge: FC<{ children: ReactNode }> = ({ children }) => {
  const { login } = usePrivy();
  return (
    <PrivyLoginContext.Provider value={login}>
      {children}
    </PrivyLoginContext.Provider>
  );
};
