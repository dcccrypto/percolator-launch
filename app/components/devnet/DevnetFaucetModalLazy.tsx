"use client";

import dynamic from "next/dynamic";
import { useWalletCompat } from "@/hooks/useWalletCompat";

const DevnetFaucetModalImpl = dynamic(() => import("./DevnetFaucetModal").then((m) => m.DevnetFaucetModal), { ssr: false });

/**
 * The global devnet faucet modal, loaded once a wallet connects. It can only show for a connected
 * wallet (useDevnetFaucet checks that wallet's balances), so a disconnected visitor never needs its
 * code: it stays out of the first-load bundle of every page.
 */
export function DevnetFaucetModal() {
  const { connected } = useWalletCompat();
  return connected ? <DevnetFaucetModalImpl /> : null;
}
