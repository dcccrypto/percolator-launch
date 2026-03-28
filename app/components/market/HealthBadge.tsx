import { FC } from "react";
import type { HealthLevel } from "@/lib/health";
import { Tooltip } from "@/components/ui/Tooltip";

const STYLES: Record<HealthLevel, string> = {
  healthy: "bg-[var(--long)]/10 text-[var(--long)] ring-1 ring-[var(--long)]/20",
  caution: "bg-[var(--warning)]/10 text-[var(--warning)] ring-1 ring-[var(--warning)]/20",
  warning: "bg-[var(--short)]/10 text-[var(--short)] ring-1 ring-[var(--short)]/20",
  empty: "bg-[var(--bg-surface)] text-[var(--text-secondary)]",
  // GH#1622: amber pulsing badge — oracle keeper hasn't cranked this market
  "oracle-down": "bg-[var(--warning)]/10 text-[var(--warning)] ring-1 ring-[var(--warning)]/30 animate-pulse",
};

const LABELS: Record<HealthLevel, string> = {
  healthy: "Healthy",
  caution: "Caution",
  warning: "Low Liq",
  empty: "Empty",
  "oracle-down": "No Oracle",
};

const TOOLTIPS: Record<HealthLevel, string> = {
  healthy: "Market has sufficient insurance and liquidity to handle normal trading activity.",
  caution: "Insurance fund is getting low relative to open positions. Market still works but may struggle with large liquidations.",
  warning: "Very low liquidity. Large trades may fail or cause high slippage. Trade with caution.",
  empty: "No active positions or liquidity in this market.",
  // GH#1622: oracle keeper hasn't pushed a price — new positions are blocked on-chain
  "oracle-down": "Oracle price unavailable — the keeper hasn't cranked this market. New position opens are blocked until the oracle is restored.",
};

export const HealthBadge: FC<{ level: HealthLevel }> = ({ level }) => (
  <Tooltip text={TOOLTIPS[level]}>
    <span className={`inline-block whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-bold ${STYLES[level]}${level === "warning" || level === "caution" || level === "oracle-down" ? " animate-pulse" : ""}`}>
      {LABELS[level]}
    </span>
  </Tooltip>
);
