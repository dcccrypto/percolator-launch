"use client";

import { FC } from "react";
import {
  computeEstimatedEntryPrice,
  computeTradingFee,
  computePreTradeLiqPrice,
} from "@/lib/trading";
import { formatUsdPriceE6, formatTokenAmount } from "@/lib/format";
import { useUsdToggle } from "@/components/providers/UsdToggleProvider";
import { useLivePrice } from "@/hooks/useLivePrice";
import {
  formatLeverage,
  ORDER_LEVERAGE_LABEL,
  ORDER_LEVERAGE_TITLE,
  RISK_LEVERAGE_LABEL,
  RISK_LEVERAGE_TITLE,
} from "@/lib/leverage-display";

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
   * Total slab account equity in collateral units (capital + realised PnL).
   * When provided, "Risk Lev." shows notional/equity for this market account.
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

  // Risk leverage = notional divided by this slab account's collateral.
  // It can be lower than the selected order leverage when the account has
  // extra margin, and this is the number that aligns with liquidation risk.
  const riskLeverage = (accountEquity != null && accountEquity > 0n)
    ? Number(notionalNative) / Number(accountEquity)
    : null;

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
          value={isLong ? "Long" : "Short"}
          valueClass={isLong ? "text-[var(--long)]" : "text-[var(--short)]"}
        />
        <SummaryRow
          label={ORDER_LEVERAGE_LABEL}
          value={formatLeverage(leverage)}
          valueClass={isLong ? "text-[var(--long)]" : "text-[var(--short)]"}
        />
        {riskLeverage !== null && (
          <SummaryRow
            label={RISK_LEVERAGE_LABEL}
            value={formatLeverage(riskLeverage)}
            valueClass="text-[var(--text-secondary)]"
          />
        )}
        <SummaryRow label="Est. Entry Price" value={formatUsdPriceE6(estEntry)} />
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
            label="Margin Usage"
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
          value={`${liqWarning ? "⚠️ " : ""}${formatUsdPriceE6(liqPrice)}`}
          valueClass={liqWarning ? "text-orange-400" : isLong ? "text-[var(--short)]" : "text-[var(--long)]"}
        />
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-[var(--text-dim)]">
        {ORDER_LEVERAGE_TITLE} {RISK_LEVERAGE_TITLE}
      </p>
    </div>
  );
};
