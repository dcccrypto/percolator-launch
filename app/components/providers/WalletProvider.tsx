"use client";

import { Component, FC, ReactNode, useMemo, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { PrivyAvailableContext, PrivyLoginContext } from "@/hooks/usePrivySafe";
import {
  PreferredWalletContext,
  usePreferredWalletState,
} from "@/hooks/usePreferredWallet";

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

/**
 * Dynamically import the Privy wrapper with SSR disabled.
 * This prevents Privy SDK from being evaluated during server-side rendering,
 * which crashes because Privy accesses browser-only APIs (window, localStorage).
 */
const PrivyProviderClient = dynamic(
  () => import("./PrivyProviderClient").then((mod) => mod.default),
  { ssr: false }
);

export const WalletProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const preferredWallet = usePreferredWalletState();

  const readOnlyFallback = (
    <PrivyAvailableContext.Provider value={false}>
      <PreferredWalletContext.Provider value={preferredWallet}>
        {children}
      </PreferredWalletContext.Provider>
    </PrivyAvailableContext.Provider>
  );

  // No app ID configured: read-only mode (skip Privy entirely)
  if (!appId) {
    return readOnlyFallback;
  }

  // Mount Privy client-side only via dynamic import (ssr: false)
  return (
    <PrivyErrorBoundary fallback={readOnlyFallback}>
      <PrivyAvailableContext.Provider value={true}>
        <PreferredWalletContext.Provider value={preferredWallet}>
          <PrivyProviderClient appId={appId}>
            {children}
          </PrivyProviderClient>
        </PreferredWalletContext.Provider>
      </PrivyAvailableContext.Provider>
    </PrivyErrorBoundary>
  );
};
