import type { Metadata } from "next";
import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Fee staking",
  description:
    "Fee staking: stake into a Percolator pool to earn a share of trading fees and help backstop permissionless perpetual markets on Solana.",
  path: "/stake",
  keywords: ["staking", "Solana staking", "DeFi pools", "protocol yield"],
});

export default function StakeLayout({ children }: { children: ReactNode }) {
  return children;
}
