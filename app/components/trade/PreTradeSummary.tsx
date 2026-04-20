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
  /** Underlying asset symbol (e.g. "SOL"). Used for notional displayed in underlying units. */
  symbol: string;
  /** Collateral token symbol (e.g. "USDC"). Used for notional/fee/margin labels. */
  collateralSymbol?: string;
  decimals: number;
  /**
   * Total account equity in collateral units (capital + realised PnL).
   * When provided, "Eff. Leverage" shows notional/equity (true account leverage).
   * Falls back to notional/margin (= slider value) when undefined.
   */
  accountEquity?: bigint | null;
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
  collateralSymbol,
  decimals,
  accountEquity,
}) => {
  const { showUsd } = useUsdToggle();
  const { priceUsd } = useLivePrice();

  if (oracleE6 === 0n || margin === 0n || positionSize === 0n) return null;

  // positionSize is in contracts (index asset units). Convert to USDC notional for display/fees.
  const notionalNative = (positionSize * oracleE6) / 1_000_000n;

  const estEntry = computeEstimatedEntryPrice(oracleE6, tradingFeeBps, direction);
  const fee = computeTradingFee(notionalNative, tradingFeeBps);
  const liqPrice = computePreTradeLiqPrice(
    oracleE6,
    margin,
    positionSize,
    maintenanceMarginBps,
    tradingFeeBps,
    direction,
  );

  const isLong = direction === "long";

  // Notional, fee, and margin are all denominated in the COLLATERAL token
  // (USDC on a SOL/USDC market), not in the underlying asset. Use
  // collateralSymbol for the label; fall back to symbol for backwards compat.
  const settleSymbol = collateralSymbol ?? symbol;
  const notionalDisplay = `${formatTokenAmount(notionalNative, decimals)} ${settleSymbol}`;
  const feeDisplay = showUsd && priceUsd != null
    ? formatNum((Number(fee) / Math.pow(10, decimals)) * priceUsd)
    : `${formatTokenAmount(fee, decimals)} ${settleSymbol}`;
  const marginDisplay = showUsd && priceUsd != null
    ? formatNum((Number(margin) / Math.pow(10, decimals)) * priceUsd)
    : `${formatTokenAmount(margin, decimals)} ${settleSymbol}`;

  // Effective leverage = notional / margin-used-for-this-trade.
  // This equals the slider value by definition (slider sets margin = notional/leverage),
  // so showing them both is somewhat redundant — but consistency matters: user sets
  // 10x and sees 10x. The account-level exposure goes in its own row below.
  const effectiveLeverage = margin > 0n
    ? Math.round((Number(notionalNative) / Number(margin)) * 10) / 10
    : 0;

  // Account usage: how much of the user's total equity this trade consumes as margin.
  // Tells the user "you're committing X% of your account to this position".
  // Only meaningful when accountEquity is known (logged-in + has an account).
  const accountUsagePct = (accountEquity != null && accountEquity > 0n && margin > 0n)
    ? Math.min(100, (Number(margin) / Number(accountEquity)) * 100)
    : null;

  // Liq price warning: if within 15% of entry
  const estEntryNum = Number(estEntry) / 1e6;
  const liqPriceNum = Number(liqPrice) / 1e6;
  const liqWarning = isLong
    ? liqPriceNum > estEntryNum * 0.85
    : liqPriceNum < estEntryNum * 1.15;

  return (
    <div className="mb-4 rounded-none border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.04)] px-3.5 py-3 text-xs">
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
        <SummaryRow
          label="Eff. Leverage"
          value={`${effectiveLeverage.toFixed(1)}x`}
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
        {accountUsagePct !== null && (
          <SummaryRow
            label="Account Usage"
            value={`${accountUsagePct.toFixed(1)}%`}
            valueClass={
              accountUsagePct >= 90
                ? "text-[var(--short)]"
                : accountUsagePct >= 50
                ? "text-orange-400"
                : "text-[var(--text)]"
            }
          />
        )}
        <SummaryRow
          label="Est. Liq Price"
          value={`${liqWarning ? "⚠️ " : ""}${formatUsd(liqPrice)}`}
          valueClass={liqWarning ? "text-orange-400" : isLong ? "text-[var(--short)]" : "text-[var(--long)]"}
        />
      </div>
    </div>
  );
};
