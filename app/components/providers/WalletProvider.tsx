"use client";

import { FC, ReactNode, Suspense, lazy, useEffect, type ComponentType } from "react";
import { AutoFundProvider } from "./AutoFundProvider";
import { PrivyBridgeHost } from "./PrivyBridgeHost";
import { PrivyAvailableContext } from "@/hooks/usePrivySafe";
import { WalletAdapterAvailableContext } from "@/hooks/useWalletAdapterAvailable";
import { DevnetFaucetModal } from "@/components/devnet/DevnetFaucetModalLazy";
import {
  PreferredWalletContext,
  usePreferredWalletState,
} from "@/hooks/usePreferredWallet";

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

  // Privy: the app is server-rendered here, outside PrivyProvider; Privy mounts client-side as a
  // sibling and bridges its state in (PrivyBridgeHost.tsx). If Privy fails it falls back to
  // read-only (PrivyAvailable false) without remounting the app.
  return (
    <WalletAdapterAvailableContext.Provider value={false}>
      <PreferredWalletContext.Provider value={preferredWallet}>
        <PrivyBridgeHost appId={appId}>
          <AutoFundProvider>
            {children}
            {/* PERC-808: Global devnet faucet modal — shown on any page when wallet
                has < 0.05 SOL or < 1,000 USDC. Decoupled from SlabProvider. */}
            <DevnetFaucetModal />
          </AutoFundProvider>
        </PrivyBridgeHost>
      </PreferredWalletContext.Provider>
    </WalletAdapterAvailableContext.Provider>
  );
};
