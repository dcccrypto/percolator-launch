"use client";

import { FC } from "react";

interface MarketPreviewProps {
  symbol: string;
  name: string;
  tokenMint: string;
  oracleMode: string;
  oracleLabel: string;
  tradingFeeBps: number;
  initialMarginBps: number;
  maxLeverage: number;
  lpCollateral: string;
  insuranceAmount: string;
  tierLabel: string;
  tierSlots: number;
  tokenDecimals: number;
  priceUsd?: number;
  inverted: boolean;
  vammEnabled: boolean;
  className?: string;
}

/**
 * Visual preview of the market as it will appear once created.
 * Mimics the trade page header / market card layout.
 */
export const MarketPreview: FC<MarketPreviewProps> = ({
  symbol,
  name,
  tokenMint,
  oracleMode,
  oracleLabel,
  tradingFeeBps,
  initialMarginBps,
  maxLeverage,
  lpCollateral,
  insuranceAmount,
  tierLabel,
  tierSlots,
  tokenDecimals,
  priceUsd,
  inverted,
  vammEnabled,
  className = "",
}) => {
  const maintenanceMarginBps = Math.floor(initialMarginBps / 2);

  return (
    <div className={`border border-[var(--accent)]/20 bg-[var(--accent)]/[0.02] ${className}`}>
      {/* Header — mimics trade page market header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--accent)]/10">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center border border-[var(--accent)]/30 bg-[var(--accent)]/[0.08] text-[12px] font-bold text-[var(--accent)]">
            {symbol.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <h3 className="text-[14px] font-bold text-white" style={{ fontFamily: "var(--font-heading)" }}>
              {symbol}/USD
            </h3>
            <p className="text-[10px] text-[var(--text-secondary)]">{name} · Perpetual</p>
          </div>
        </div>
        <div className="text-right">
          {priceUsd && priceUsd > 0 ? (
            <p className="text-[14px] font-bold font-mono text-white">
              ${priceUsd.toLocaleString(undefined, { maximumFractionDigits: 6 })}
            </p>
          ) : (
            <p className="text-[12px] text-[var(--text-dim)]">Price TBD</p>
          )}
          <span className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.06] px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.1em] text-[var(--accent)]">
            {tierLabel}
          </span>
        </div>
      </div>

      {/* Stats Grid — mimics trade page stats */}
      <div className="grid grid-cols-4 gap-px bg-[var(--border)]">
        {[
          { label: "Max Leverage", value: `${maxLeverage}x` },
          { label: "Trading Fee", value: `${(tradingFeeBps / 100).toFixed(2)}%` },
          { label: "Init Margin", value: `${(initialMarginBps / 100).toFixed(0)}%` },
          { label: "Maint Margin", value: `${(maintenanceMarginBps / 100).toFixed(1)}%` },
        ].map((stat) => (
          <div key={stat.label} className="bg-[var(--panel-bg)] px-3 py-3 text-center">
            <p className="text-[8px] font-medium uppercase tracking-[0.2em] text-[var(--text)]">{stat.label}</p>
            <p className="mt-1 text-[13px] font-bold text-[var(--text)]">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Market Details */}
      <div className="px-5 py-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[8px] font-medium uppercase tracking-[0.2em] text-[var(--text)]">LP Collateral</p>
            <p className="mt-0.5 text-[12px] font-semibold text-[var(--text)]">
              {parseFloat(lpCollateral) > 0 ? `${parseFloat(lpCollateral).toLocaleString()} ${symbol}` : "—"}
            </p>
          </div>
          <div>
            <p className="text-[8px] font-medium uppercase tracking-[0.2em] text-[var(--text)]">Insurance Fund</p>
            <p className="mt-0.5 text-[12px] font-semibold text-[var(--text)]">
              {parseFloat(insuranceAmount) > 0 ? `${parseFloat(insuranceAmount).toLocaleString()} ${symbol}` : "—"}
            </p>
          </div>
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-1.5">
          <span className="border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-0.5 text-[9px] font-medium text-[var(--text-secondary)]">
            {oracleMode === "auto" ? "Auto Oracle" : oracleMode === "dex" ? "DEX Oracle" : oracleMode === "pyth" ? "Pyth Oracle" : "Admin Oracle"}
          </span>
          <span className="border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-0.5 text-[9px] font-medium text-[var(--text-secondary)]">
            {tierSlots} Slots
          </span>
          <span className="border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-0.5 text-[9px] font-medium text-[var(--text-secondary)]">
            {tokenDecimals} Decimals
          </span>
          {inverted && (
            <span className="border border-[var(--warning)]/30 bg-[var(--warning)]/[0.06] px-2 py-0.5 text-[9px] font-medium text-[var(--warning)]">
              Inverted
            </span>
          )}
          {vammEnabled && (
            <span className="border border-[var(--accent)]/30 bg-[var(--accent)]/[0.06] px-2 py-0.5 text-[9px] font-medium text-[var(--accent)]">
              vAMM
            </span>
          )}
        </div>

        {/* Mint Address */}
        <div>
          <p className="text-[8px] font-medium uppercase tracking-[0.2em] text-[var(--text)]">Token Mint</p>
          <p className="mt-0.5 font-mono text-[10px] text-[var(--text-secondary)] break-all">{tokenMint}</p>
        </div>

        {/* Oracle Info */}
        <div>
          <p className="text-[8px] font-medium uppercase tracking-[0.2em] text-[var(--text)]">Oracle Source</p>
          <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{oracleLabel}</p>
        </div>
      </div>
    </div>
  );
};
