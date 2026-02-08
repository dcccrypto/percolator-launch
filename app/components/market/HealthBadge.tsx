import { FC } from "react";
import type { HealthLevel } from "@/lib/health";

const STYLES: Record<HealthLevel, string> = {
  healthy: "bg-green-900/40 text-green-400",
  caution: "bg-yellow-900/40 text-yellow-400",
  warning: "bg-red-900/40 text-red-400",
  empty: "bg-[#1a1a2e] text-[#71717a]",
};

const LABELS: Record<HealthLevel, string> = {
  healthy: "Healthy",
  caution: "Caution",
  warning: "Low Liquidity",
  empty: "Empty",
};

export const HealthBadge: FC<{ level: HealthLevel }> = ({ level }) => (
  <span
    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[level]}`}
  >
    {LABELS[level]}
  </span>
);
