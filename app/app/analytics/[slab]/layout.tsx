import type { Metadata } from "next";
import type { ReactNode } from "react";

// page.tsx is a client component ("use client"), which can't export metadata —
// without this layout the route inherited the root layout's generic title.
// Static title (no per-market fetchMarketMeta here): keeping this layout
// synchronous means navigation to analytics never blocks on a metadata fetch
// — the same loading.tsx-skeleton trap the trade route's layout had.
export const metadata: Metadata = {
  title: "Market Analytics",
  description:
    "Deep market analytics — engine health, crank status, open interest, insurance fund, and liquidations for a Percolator market.",
};

export default function AnalyticsSlabLayout({ children }: { children: ReactNode }) {
  return children;
}
