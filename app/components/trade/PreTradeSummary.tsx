"use client";

import { FC } from "react";
import {
  computeEstimatedEntryPrice,
  computeTradingFee,
  computePreTradeLiqPrice,
} from "@/lib/trading";
import { formatUsd, formatTokenAmount } from "@/lib/format";
import { useUsdToggle } from "@/components/providers/UsdToggleProvider";
import { useLivePrice } from "@/hooks/useLivePrice";

function formatNum(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface PreTradeSummaryProps {
  oracleE6: bigint;
  margin: bigint;
  positionSize: bigint;
  direction: "long" | "short";
  leverage: number;
  tradingFeeBps: bigint;
  maintenanceMarginBps: bigint;
  symbol: string;
  decimals: number;
}

function SummaryRow({
  label,
  value,
  valueClass = "text-[var(--text)]",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className={`font-mono font-medium ${valueClass}`}>{value}</span>
    </div>
  );
}

export const PreTradeSummary: FC<PreTradeSummaryProps> = ({
  oracleE6,
  margin,
  positionSize,
  direction,
  leverage,
  tradingFeeBps,
  maintenanceMarginBps,
  symbol,
  decimals,
}) => {
  const { showUsd } = useUsdToggle();
  const { priceUsd } = useLivePrice();

  if (oracleE6 === 0n || margin === 0n || positionSize === 0n) return null;

  const estEntry = computeEstimatedEntryPrice(oracleE6, tradingFeeBps, direction);
  const fee = computeTradingFee(positionSize, tradingFeeBps);
  const liqPrice = computePreTradeLiqPrice(
    oracleE6,
    margin,
    positionSize,
    maintenanceMarginBps,
    tradingFeeBps,
    direction,
  );

  const isLong = direction === "long";

  // Convert to USD if toggle enabled
  const notionalDisplay = showUsd && priceUsd != null
    ? formatNum((Number(positionSize) / Math.pow(10, decimals)) * priceUsd)
    : `${formatTokenAmount(positionSize, decimals)} ${symbol}`;
  const feeDisplay = showUsd && priceUsd != null
    ? formatNum((Number(fee) / Math.pow(10, decimals)) * priceUsd)
    : `${formatTokenAmount(fee, decimals)} ${symbol}`;
  const marginDisplay = showUsd && priceUsd != null
    ? formatNum((Number(margin) / Math.pow(10, decimals)) * priceUsd)
    : `${formatTokenAmount(margin, decimals)} ${symbol}`;

  return (
    <div className="mb-4 rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 px-3.5 py-3 text-xs">
      <div className="mb-2 flex items-center gap-2">
        <div className={`h-1.5 w-1.5 rounded-full ${isLong ? "bg-[var(--long)]" : "bg-[var(--short)]"}`} />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
          Order Summary
        </span>
      </div>

      <div className="space-y-0.5 divide-y divide-[var(--border)]/50">
        <SummaryRow
          label="Direction"
          value={`${isLong ? "Long" : "Short"} ${leverage}x`}
          valueClass={isLong ? "text-[var(--long)]" : "text-[var(--short)]"}
        />
        <SummaryRow label="Est. Entry Price" value={formatUsd(estEntry)} />
        <SummaryRow
          label="Notional Value"
          value={notionalDisplay}
        />
        <SummaryRow
          label="Trading Fee"
          value={feeDisplay}
          valueClass="text-[var(--text-secondary)]"
        />
        <SummaryRow
          label="Margin Required"
          value={marginDisplay}
        />
        <SummaryRow
          label="Est. Liq Price"
          value={formatUsd(liqPrice)}
          valueClass={isLong ? "text-[var(--short)]" : "text-[var(--long)]"}
        />
      </div>
    </div>
  );
};
