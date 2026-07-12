import type { Metadata } from "next";
import type { ReactNode } from "react";

// page.tsx is a client component ("use client"), which can't export metadata —
// without this layout the route inherited the root layout's generic title.
export const metadata: Metadata = {
  title: "Faucet — Test Funds",
  description:
    "Get devnet SOL and sim-USDC test funds to trade on the Percolator playground.",
};

export default function FaucetLayout({ children }: { children: ReactNode }) {
  return children;
}
