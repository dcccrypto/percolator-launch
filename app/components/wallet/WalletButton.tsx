"use client";

/**
 * Privy-powered wallet button — replaces WalletMultiButton from wallet-adapter-react-ui.
 */

import { usePrivy } from "@privy-io/react-auth";
import { useLogin } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";

export function WalletButton() {
  const { ready, authenticated, logout } = usePrivy();
  const { login } = useLogin();
  const { wallets } = useWallets();

  if (!ready) {
    return (
      <button className="wallet-adapter-button" disabled>
        Loading...
      </button>
    );
  }

  if (!authenticated) {
    return (
      <button className="wallet-adapter-button" onClick={() => login()}>
        Connect Wallet
      </button>
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wallet = wallets.find((w) => (w as any).walletClientType !== "privy") ?? wallets[0];
  const addr = wallet?.address;
  const short = addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : "Connected";

  return (
    <button className="wallet-adapter-button wallet-adapter-button-trigger" onClick={() => logout()}>
      {short}
    </button>
  );
}
