"use client";

/**
 * Wallet connection modal — now powered by Privy.
 * Privy handles the full modal UI (wallet selection, email login, embedded wallet).
 * This component is a thin wrapper that triggers Privy's login flow.
 */

import { FC } from "react";
import { useLogin, usePrivy } from "@privy-io/react-auth";

export const AccessibleWalletModal: FC = () => {
  // Privy handles the modal internally — nothing to render here.
  // The modal is triggered by calling `login()` from useLogin.
  return null;
};

/**
 * Hook to open the wallet connect modal (Privy login).
 * Drop-in replacement for useWalletModal().setVisible(true).
 */
export function useWalletModal() {
  const { authenticated, logout } = usePrivy();
  const { login } = useLogin();

  return {
    visible: false,
    setVisible: (show: boolean) => {
      if (show && !authenticated) {
        login();
      }
    },
    login,
    logout,
  };
}
