import type { Metadata } from "next";
import type { ReactNode } from "react";
import { pageMetadata } from "@/lib/seo";
import { parseTraderWallet, shortWallet, traderPath } from "@/lib/trader-profile";

/**
 * Trader profiles are public but not indexed: anyone can open one from the leaderboard, while search
 * engines are asked not to catalogue every wallet address.
 */
export async function generateMetadata({ params }: { params: Promise<{ wallet: string }> }): Promise<Metadata> {
  const wallet = parseTraderWallet((await params).wallet);
  return pageMetadata({
    title: wallet ? `Trader ${shortWallet(wallet)}` : "Trader",
    description: "Trading activity, open positions and created markets for this wallet on Percolator.",
    path: wallet ? traderPath(wallet) : "/leaderboard",
    noindex: true,
  });
}

export default function TraderLayout({ children }: { children: ReactNode }) {
  return children;
}
