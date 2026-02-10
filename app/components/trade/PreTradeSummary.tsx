"use client";

import { FC } from "react";
import {
  computeEstimatedEntryPrice,
  computeTradingFee,
  computePreTradeLiqPrice,
} from "@/lib/trading";
import { formatUsd, formatTokenAmount } from "@/lib/format";

interface PreTradeSummaryProps {
  oracleE6: bigint;
  margin: bigint;
  positionSize: bigint;
  direction: "long" | "short";
  leverage: number;
  tradingFeeBps: bigint;
  maintenanceMarginBps: bigint;
  symbol: string;
}

function SummaryRow({
  label,
  value,
  valueClass = "text-[#F0F4FF]",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[#5a6382]">{label}</span>
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
}) => {
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

  return (
    <div className="mb-4 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 text-xs backdrop-blur-sm">
      <div className="mb-2 flex items-center gap-2">
        <div className={`h-1.5 w-1.5 rounded-full ${isLong ? "bg-[#00FFB2]" : "bg-red-500"}`} />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[#5a6382]">
          Order Summary
        </span>
      </div>

      <div className="space-y-0.5 divide-y divide-[#1e2433]/50">
        <SummaryRow
          label="Direction"
          value={`${isLong ? "Long" : "Short"} ${leverage}x`}
          valueClass={isLong ? "text-[#00FFB2]" : "text-red-400"}
        />
        <SummaryRow label="Est. Entry Price" value={formatUsd(estEntry)} />
        <SummaryRow
          label="Notional Value"
          value={`${formatTokenAmount(positionSize)} ${symbol}`}
        />
        <SummaryRow
          label="Trading Fee"
          value={`${formatTokenAmount(fee)} ${symbol}`}
          valueClass="text-[#8B95B0]"
        />
        <SummaryRow
          label="Margin Required"
          value={`${formatTokenAmount(margin)} ${symbol}`}
        />
        <SummaryRow
          label="Est. Liq Price"
          value={formatUsd(liqPrice)}
          valueClass={isLong ? "text-red-400" : "text-[#00FFB2]"}
        />
      </div>
    </div>
  );
};
