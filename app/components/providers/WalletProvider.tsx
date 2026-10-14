"use client";

import { Component, FC, ReactNode, Suspense, lazy, useEffect, type ComponentType } from "react";
import dynamic from "next/dynamic";
import { AutoFundProvider } from "./AutoFundProvider";
import { PrivyAvailableContext } from "@/hooks/usePrivySafe";
import { WalletAdapterAvailableContext } from "@/hooks/useWalletAdapterAvailable";
import { DevnetFaucetModal } from "@/components/devnet/DevnetFaucetModal";
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
 *
 * Privy deployments still bail the page out of server rendering (the server HTML body is empty
 * until this chunk runs). Rendering the children on the server without Privy is not an option
 * here: PrivyProvider's internal tree shifts every descendant's React useId, so the server and
 * client markup would disagree (measured 2026-10-14: label/input ids on /stake). The
 * wallet-adapter path below has no such problem and is server-rendered.
 */
const PrivyProviderClient = dynamic(
  () => import("./PrivyProviderClient").then((mod) => mod.default),
  { ssr: false }
);

/**
 * The wallet-adapter provider, used when NEXT_PUBLIC_PRIVY_APP_ID is not set so any user can
 * connect Phantom / Solflare / Backpack (or any Wallet Standard wallet) without a Privy account.
 *
 * It used to be mounted with `next/dynamic({ ssr: false })` AROUND the whole app, which made every
 * page bail out of server rendering: the server HTML body was empty and nothing painted until the
 * wallet chunk had downloaded and run (measured 2026-10-14: landing LCP 11.5 s on Lighthouse mobile,
 * the whole <body> = BAILOUT_TO_CLIENT_SIDE_RENDERING).
 *
 * Now the server renders the children directly (no wallet SDK, never evaluated on the server), so
 * the page HTML is real content. On the client the provider is a React.lazy component inside a
 * <Suspense>: during hydration the chunk suspends, React keeps the server HTML on screen and hydrates
 * it in place once the chunk arrives (no remount, no blank page, no flash). The provider renders
 * exactly its children, one child per level, so the server and client markup (and useIds) agree.
 * Components whose output depends on the browser's wallets render a stable placeholder for the
 * hydration pass (ConnectButtonAdapterGate).
 */
function clientOnlyProvider<P extends { children?: ReactNode }>(LazyProvider: ComponentType<P>): FC<P> {
  const ClientOnlyProvider: FC<P> = (props) => {
    if (typeof window === "undefined") return <>{props.children}</>;
    return <LazyProvider {...props} />;
  };
  return ClientOnlyProvider;
}

const WalletAdapterProviderClient = clientOnlyProvider(lazy(() => import("./WalletAdapterProviderClient")));

export const WalletProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const preferredWallet = usePreferredWalletState();

  // LAUNCH-H2: Warn at startup if the WSS key equals the HTTP key.
  // Actual key rotation is an operator task (Helius dashboard), but this gives
  // devs a loud signal so it doesn't get missed before mainnet.
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      process.env.NEXT_PUBLIC_HELIUS_API_KEY &&
      process.env.NEXT_PUBLIC_HELIUS_WS_API_KEY === process.env.NEXT_PUBLIC_HELIUS_API_KEY
    ) {
      console.warn(
        '[percolator-launch] SECURITY: NEXT_PUBLIC_HELIUS_WS_API_KEY equals NEXT_PUBLIC_HELIUS_API_KEY. ' +
        'Create a WSS-restricted key in the Helius dashboard and use that for WS.'
      );
    }
  }, []);

  const readOnlyFallback = (
    <PrivyAvailableContext.Provider value={false}>
      <WalletAdapterAvailableContext.Provider value={false}>
        <PreferredWalletContext.Provider value={preferredWallet}>
          {children}
        </PreferredWalletContext.Provider>
      </WalletAdapterAvailableContext.Provider>
    </PrivyAvailableContext.Provider>
  );

  // No Privy app ID → use wallet-adapter so anyone with Phantom/Solflare/Backpack
  // can connect without a Privy account. WalletAdapterAvailableContext is set to
  // true so ConnectButton and useWalletCompat take the adapter path.
  if (!appId) {
    return (
      <PrivyAvailableContext.Provider value={false}>
        <WalletAdapterAvailableContext.Provider value={true}>
          <PreferredWalletContext.Provider value={preferredWallet}>
            <Suspense fallback={null}>
              <WalletAdapterProviderClient>
                {children}
                {/* UX WP-10 (FA-2): the faucet modal is mounted in BOTH provider branches. */}
                <DevnetFaucetModal />
              </WalletAdapterProviderClient>
            </Suspense>
          </PreferredWalletContext.Provider>
        </WalletAdapterAvailableContext.Provider>
      </PrivyAvailableContext.Provider>
    );
  }

  // Mount Privy client-side only via dynamic import (ssr: false)
  return (
    <PrivyErrorBoundary fallback={readOnlyFallback}>
      <PrivyAvailableContext.Provider value={true}>
        <WalletAdapterAvailableContext.Provider value={false}>
          <PreferredWalletContext.Provider value={preferredWallet}>
            <PrivyProviderClient appId={appId}>
              <AutoFundProvider>
                {children}
                {/* PERC-808: Global devnet faucet modal — shown on any page when wallet
                    has < 0.05 SOL or < 1,000 USDC. Decoupled from SlabProvider. */}
                <DevnetFaucetModal />
              </AutoFundProvider>
            </PrivyProviderClient>
          </PreferredWalletContext.Provider>
        </WalletAdapterAvailableContext.Provider>
      </PrivyAvailableContext.Provider>
    </PrivyErrorBoundary>
  );
};
// wallet connect fix - 1775223675
// privy fix 1775223899
