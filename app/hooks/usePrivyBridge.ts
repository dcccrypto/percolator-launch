"use client";

import { createContext, useContext } from "react";
import type { ConnectWalletModalOptions, LoginModalOptions, usePrivy } from "@privy-io/react-auth";
import type { useFundWallet, useWallets } from "@privy-io/react-auth/solana";

/**
 * The Privy values the app reads, published into our own React context by `PrivyBridge`
 * (components/providers/PrivyProviderClient.tsx), which is the only place that calls the real Privy
 * hooks. PrivyProvider is mounted as a SIBLING of the app (never around it) so its internal tree
 * cannot shift the app's React useIds, and so pages can be server-rendered under a Privy app id.
 * Every consumer therefore reads this bridge instead of importing `@privy-io/react-auth`; this
 * module has type-only Privy imports, so no Privy code lands in the shared bundle.
 *
 * Until Privy is up the value is `PRIVY_NOT_READY`: `ready` false, nothing authenticated, no wallets,
 * and no-op actions. That is also exactly what the server renders.
 *
 * Every function here has a stable identity for the life of the page (they read the latest Privy
 * function through a ref), because consumers key effects and SWR keys on them.
 */
type PrivyApi = ReturnType<typeof usePrivy>;

export interface PrivyBridgeValue {
  /** `usePrivy().ready` */
  ready: boolean;
  /** `usePrivy().authenticated` */
  authenticated: boolean;
  /** `usePrivy().user` */
  user: PrivyApi["user"];
  /** `usePrivy().logout` */
  logout: PrivyApi["logout"];
  /** `usePrivy().exportWallet` */
  exportWallet: PrivyApi["exportWallet"];
  /** `usePrivy().getAccessToken` */
  getAccessToken: PrivyApi["getAccessToken"];
  /** `useIdentityToken().identityToken` (a value: it changes when Privy refreshes it). */
  identityToken: string | null;
  /** `useWallets().ready` from `@privy-io/react-auth/solana`. */
  walletsReady: boolean;
  /** `useWallets().wallets` from `@privy-io/react-auth/solana`. */
  wallets: ReturnType<typeof useWallets>["wallets"];
  /** `useFundWallet().fundWallet` */
  fundWallet: ReturnType<typeof useFundWallet>["fundWallet"];
  /** `useLogin().login`: opens the Privy sign-in modal. The preferred wallet is bound on completion. */
  login: (options?: LoginModalOptions) => void;
  /** `useConnectWallet().connectWallet`: re-prompts an external wallet. The connected wallet becomes the signer. */
  connectWallet: (options?: ConnectWalletModalOptions) => void;
  /**
   * `usePrivy().linkTwitter`: redirects to X. Rejects on a failure before the redirect (e.g. Privy's
   * OAuth init refusing X); the result comes back on the next page load as `user.twitter`.
   */
  linkTwitter: () => Promise<void>;
  /** `usePrivy().unlinkOAuth` (= `useUnlinkOAuth().unlink`). `user` updates when it resolves. */
  unlinkOAuth: PrivyApi["unlinkOAuth"];
}

const noopAsync = async (): Promise<void> => {};
const notReady = async (): Promise<never> => {
  throw new Error("Privy is not ready");
};

export const PRIVY_NOT_READY: PrivyBridgeValue = {
  ready: false,
  authenticated: false,
  user: null,
  logout: noopAsync,
  exportWallet: (async () => {}) as PrivyApi["exportWallet"],
  getAccessToken: async () => null,
  identityToken: null,
  walletsReady: false,
  wallets: [],
  fundWallet: (async () => {}) as ReturnType<typeof useFundWallet>["fundWallet"],
  login: () => {},
  connectWallet: () => {},
  linkTwitter: notReady,
  unlinkOAuth: notReady,
};

export const PrivyBridgeContext = createContext<PrivyBridgeValue>(PRIVY_NOT_READY);

/**
 * Privy's state and actions. Safe anywhere: outside a Privy deployment, or while Privy is still
 * loading, it is `PRIVY_NOT_READY` (the same value the server renders).
 */
export function usePrivyBridge(): PrivyBridgeValue {
  return useContext(PrivyBridgeContext);
}
