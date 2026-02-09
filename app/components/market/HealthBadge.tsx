import { FC } from "react";
import type { HealthLevel } from "@/lib/health";
import { Tooltip } from "@/components/ui/Tooltip";

const STYLES: Record<HealthLevel, string> = {
  healthy: "bg-[#00e68a]/10 text-[#00e68a] ring-1 ring-[#00e68a]/20",
  caution: "bg-[#ffaa00]/10 text-[#ffaa00] ring-1 ring-[#ffaa00]/20",
  warning: "bg-[#ff4d6a]/10 text-[#ff4d6a] ring-1 ring-[#ff4d6a]/20",
  empty: "bg-white/[0.06] text-[#8B95B0]",
};

const LABELS: Record<HealthLevel, string> = {
  healthy: "Healthy",
  caution: "Caution",
  warning: "Low Liq",
  empty: "Empty",
};

const TOOLTIPS: Record<HealthLevel, string> = {
  healthy: "Market has sufficient insurance and liquidity to handle normal trading activity.",
  caution: "Insurance fund is getting low relative to open positions. Market still works but may struggle with large liquidations.",
  warning: "Very low liquidity. Large trades may fail or cause high slippage. Trade with caution.",
  empty: "No active positions or liquidity in this market.",
};

export const HealthBadge: FC<{ level: HealthLevel }> = ({ level }) => (
  <Tooltip text={TOOLTIPS[level]}>
    <span className={`inline-block rounded-md px-1.5 py-0.5 text-[10px] font-bold ${STYLES[level]}`}>
      {LABELS[level]}
    </span>
  </Tooltip>
);
