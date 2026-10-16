"use client";

import { useCallback, useMemo, useRef } from "react";
import { useConnectWallet, useIdentityToken, useLogin, usePrivy } from "@privy-io/react-auth";
import { useFundWallet, useWallets } from "@privy-io/react-auth/solana";
import type { PrivySessionHeaders } from "@/hooks/usePrivySafe";
import type { PrivyBridgeValue } from "@/hooks/usePrivyBridge";
import { usePreferredWallet } from "@/hooks/usePreferredWallet";

/**
 * The "connect wallet" action. It must never be a silent no-op. Privy's session (refresh token)
 * outlives the wallet connection: after e.g. an overnight extension lock, Privy's silent
 * reconnect fails, `authenticated` stays true, and no Solana wallet is connected. `login()` in
 * that state only logs "Attempted to log in, but user is already logged in"
 * (@privy-io/react-auth 3.41.0) and returns, so every Connect CTA was dead. When authenticated we
 * therefore open `connectWallet()`, which re-prompts the external wallet.
 */
function usePrivyConnectSurface() {
  const { setPreferredAddress } = usePreferredWallet();
  const { authenticated, getAccessToken } = usePrivy();
  const { identityToken } = useIdentityToken();

  // The Privy session headers, read at call time through refs so the getter's identity never
  // changes (same reason as useAdminFetch): consumers key effects on it.
  const sessionRef = useRef({ authenticated, getAccessToken, identityToken });
  sessionRef.current = { authenticated, getAccessToken, identityToken };
  const sessionHeaders = useCallback<PrivySessionHeaders>(async () => {
    const s = sessionRef.current;
    if (!s.authenticated) return null;
    const accessToken = await s.getAccessToken();
    if (!accessToken) return null;
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (s.identityToken) headers["x-privy-id-token"] = s.identityToken;
    return headers;
  }, []);

  const { login } = useLogin({
    onComplete: ({ loginAccount }) => {
      // This bridge backs Trade/Faucet and other callers of usePrivyLogin().
      // Persist the wallet that actually authenticated the session.
      if (loginAccount?.type === "wallet" && loginAccount.chainType === "solana") {
        setPreferredAddress(loginAccount.address);
      }
    },
  });

  // #2620 semantics for (re)connects: the wallet the user explicitly connects
  // becomes the active signer. `useConnectWallet` subscribes to Privy's global
  // `connectWallet` event, so this also covers the header's Reconnect button.
  // Privy does not fire it for wallet-login or link flows (those go through
  // `onComplete` above).
  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => {
      if (wallet.type === "solana") {
        setPreferredAddress(wallet.address);
      }
    },
  });

  const connect = useCallback(() => {
    if (authenticated) {
      connectWallet({ walletChainType: "solana-only" });
      return;
    }
    login();
  }, [authenticated, connectWallet, login]);

  return { connect, sessionHeaders, login, connectWallet, identityToken };
}


/**
 * Privy's state and actions as the app-facing `PrivyBridgeValue`, plus the connect action and the
 * session-header getter. Must run inside PrivyProvider. Functions go out through stable wrappers
 * over the latest Privy function: consumers key effects and SWR keys on them, and Privy hands back
 * fresh identities on re-renders.
 */
export function usePrivyBridgeState(): {
  privy: PrivyBridgeValue;
  connect: () => void;
  sessionHeaders: PrivySessionHeaders;
} {
  const { connect, sessionHeaders, login, connectWallet, identityToken } = usePrivyConnectSurface();
  const { ready, authenticated, logout, exportWallet, getAccessToken, user } = usePrivy();
  const { ready: walletsReady, wallets } = useWallets();
  const { fundWallet } = useFundWallet();

  const latest = useRef({ logout, exportWallet, getAccessToken, fundWallet, login, connectWallet });
  latest.current = { logout, exportWallet, getAccessToken, fundWallet, login, connectWallet };
  const stable = useMemo(
    () => ({
      logout: ((...a) => latest.current.logout(...a)) as PrivyBridgeValue["logout"],
      exportWallet: ((...a) => latest.current.exportWallet(...a)) as PrivyBridgeValue["exportWallet"],
      getAccessToken: ((...a) => latest.current.getAccessToken(...a)) as PrivyBridgeValue["getAccessToken"],
      fundWallet: ((...a) => latest.current.fundWallet(...a)) as PrivyBridgeValue["fundWallet"],
      login: ((o) => latest.current.login(o)) as PrivyBridgeValue["login"],
      connectWallet: ((o) => latest.current.connectWallet(o)) as PrivyBridgeValue["connectWallet"],
    }),
    [],
  );

  const privy = useMemo<PrivyBridgeValue>(
    () => ({
      ready,
      authenticated,
      user,
      identityToken: identityToken ?? null,
      walletsReady: walletsReady === true,
      wallets,
      ...stable,
    }),
    [ready, authenticated, user, identityToken, walletsReady, wallets, stable],
  );

  return { privy, connect, sessionHeaders };
}
