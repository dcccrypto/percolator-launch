import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GrowthDashboard } from "@/components/v21/GrowthDashboard";
import { isDevnetV21Enabled } from "@/lib/v21/flag";

export const metadata: Metadata = {
  title: "Growth | Percolator",
  description: "Per-market capacity, utilisation, max leverage and Earn NAV over time (Devnet v2.1).",
};

/** Devnet v2.1 only: 404 with NEXT_PUBLIC_DEVNET_V21 off, and the dashboard (and its fetches) never mount. */
export default function GrowthPage() {
  if (!isDevnetV21Enabled()) notFound();
  return <GrowthDashboard />;
}
