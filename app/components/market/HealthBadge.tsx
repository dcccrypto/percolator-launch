import { FC } from "react";
import type { HealthLevel } from "@/lib/health";

const STYLES: Record<HealthLevel, string> = {
  healthy: "bg-[#00e68a]/10 text-[#00e68a] ring-1 ring-[#00e68a]/20",
  caution: "bg-[#ffaa00]/10 text-[#ffaa00] ring-1 ring-[#ffaa00]/20",
  warning: "bg-[#ff4d6a]/10 text-[#ff4d6a] ring-1 ring-[#ff4d6a]/20",
  empty: "bg-[#1a1d2a] text-[#4a5068]",
};

const LABELS: Record<HealthLevel, string> = {
  healthy: "Healthy",
  caution: "Caution",
  warning: "Low Liq",
  empty: "Empty",
};

export const HealthBadge: FC<{ level: HealthLevel }> = ({ level }) => (
  <span className={`inline-block rounded-md px-1.5 py-0.5 text-[10px] font-bold ${STYLES[level]}`}>
    {LABELS[level]}
  </span>
);
