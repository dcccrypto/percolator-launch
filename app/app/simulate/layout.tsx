import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Risk Engine Simulator | Percolator",
  description:
    "Experience Percolator's perpetuals risk engine firsthand — funding rates, liquidations, insurance fund mechanics — using simulated funds on devnet. No real money at risk.",
  openGraph: {
    title: "Risk Engine Simulator | Percolator",
    description:
      "Trade perps with zero risk. Explore Percolator's risk engine — funding rates, liquidations, insurance fund — with simulated funds on Solana devnet.",
    type: "website",
    siteName: "Percolator",
  },
  twitter: {
    card: "summary_large_image",
    title: "Risk Engine Simulator | Percolator",
    description:
      "Trade perps with simulated funds on Solana devnet. Compete on the weekly leaderboard.",
    site: "@Percolator_ct",
  },
  keywords: [
    "percolator",
    "solana",
    "perpetuals",
    "defi",
    "simulator",
    "devnet",
    "risk engine",
    "trading",
    "leaderboard",
  ],
};

export default function SimulateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
