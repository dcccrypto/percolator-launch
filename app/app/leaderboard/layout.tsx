import type { Metadata } from "next";
import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Trader Leaderboard",
  description:
    "See the top traders on Percolator ranked by trade volume. Live leaderboard for permissionless perpetual futures on Solana.",
  path: "/leaderboard",
  keywords: ["trading leaderboard", "top traders", "trading volume", "Solana perps"],
});

export default function LeaderboardLayout({ children }: { children: ReactNode }) {
  return children;
}
