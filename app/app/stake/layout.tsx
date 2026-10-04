import type { Metadata } from "next";
import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Fee staking",
  description:
    "Fee staking: stake into a market's pool to receive a share of that market's trading fees. The pool admin can move staked funds into the market's insurance fund, where trading losses can use them, so your stake can lose value.",
  path: "/stake",
  keywords: ["staking", "Solana staking", "DeFi pools", "protocol yield"],
});

export default function StakeLayout({ children }: { children: ReactNode }) {
  return children;
}
