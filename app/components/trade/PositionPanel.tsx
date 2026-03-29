"use client";

import { FC, useMemo, useState, useRef, useEffect } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { AccountKind } from "@percolator/sdk";
import { formatTokenAmount, formatUsd, formatLiqPrice } from "@/lib/format";
import { useLivePrice } from "@/hooks/useLivePrice";
import {
  computeMarkPnl,
  computeLiqPrice,
  computePnlPercent,
} from "@/lib/trading";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";
import { WarmupProgress } from "./WarmupProgress";
import { ClosePositionModal } from "./ClosePositionModal";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { sanitizeFundingRateBps } from "@/lib/health";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/** Format seconds into "Xh Ym" countdown string. */
function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "soon";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export const PositionPanel: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccount(slabAddress) : null);
  const config = useMarketConfig();
  const { engine: engineState, fundingRate } = useEngineState();
  const { accounts, config: mktConfig, params } = useSlabState();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const mintAddress = mktConfig?.collateralMint?.toBase58() ?? "";
  const symbol = sanitizeSymbol(tokenMeta?.symbol, mintAddress);
  const decimals = tokenMeta?.decimals ?? 6;

  const { closePosition, loading: closeLoading, error: closeError } = useClosePosition(slabAddress);
  const [showCloseModal, setShowCloseModal] = useState(false);

  // 3.2: PnL flash on sign change
  const [pnlFlash, setPnlFlash] = useState<"long" | "short" | null>(null);
  const prevPnlSignRef = useRef<"positive" | "negative" | "zero" | null>(null);

  const lpEntry = useMemo(() => {
    return accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null;
  }, [accounts]);

  // Bug #267a67ef: LP with 0 capital cannot accept counterparty positions
  const lpUnderfunded = lpEntry !== null && lpEntry.account.capital === 0n;

  if (!userAccount) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex flex-col items-center py-6 text-center">
          <p className="text-[11px] font-medium text-[var(--text-muted)]">No open position</p>
          <p className="mt-1.5 text-[10px] text-[var(--text-dim)] leading-relaxed max-w-[240px]">
            Connect wallet and trade to get started.
          </p>
          {/* 3.5: CTA for no-wallet state */}
          <a
            href="#trade-form"
            className="mt-3 inline-block border border-[var(--accent)]/40 px-3 py-1 text-[10px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/[0.06]"
          >
            Connect Wallet
          </a>
        </div>
      </div>
    );
  }

  const { account } = userAccount;
  const hasPosition = account.positionSize !== 0n;
  const isLong = account.positionSize > 0n;
  const absPosition = abs(account.positionSize);
  const onChainPriceE6 = config?.lastEffectivePriceE6 ?? null;
  const currentPriceE6 = livePriceE6 ?? onChainPriceE6 ?? 0n;

  const entryPriceE6 = account.entryPrice;

  // PERC-297: Mark price is considered "available" when it's a positive value.
  const hasValidMark = currentPriceE6 > 0n;

  // Bug fix: Don't compute P&L with stale/zero price to avoid flash
  const pnlTokens = hasValidMark ? computeMarkPnl(
    account.positionSize,
    account.entryPrice,
    currentPriceE6,
  ) : 0n;
  const pnlUsdRaw =
    priceUsd !== null && hasValidMark ? (Number(pnlTokens) / 10 ** decimals) * priceUsd : null;
  const pnlUsd = pnlUsdRaw !== null && Number.isFinite(pnlUsdRaw) ? pnlUsdRaw : null;
  const roe = hasValidMark ? computePnlPercent(pnlTokens, account.capital) : 0;

  const maintenanceBps = params?.maintenanceMarginBps ?? 500n;
  const liqPriceE6 = computeLiqPrice(
    entryPriceE6,
    account.capital,
    account.positionSize,
    maintenanceBps,
  );

  // Liq price danger color: amber when mark is within 15% of liq
  const liqDistPct = (() => {
    if (liqPriceE6 <= 0n || !hasValidMark || currentPriceE6 <= 0n) return Infinity;
    return Math.abs(Number(currentPriceE6) - Number(liqPriceE6)) / Number(currentPriceE6);
  })();

  const liqPriceColor = (() => {
    if (liqPriceE6 <= 0n || !hasValidMark || currentPriceE6 <= 0n) return "text-[var(--warning)]";
    if (liqDistPct < 0.05) return "text-[var(--short)]";   // <5% — critical red
    if (liqDistPct < 0.10) return "text-[var(--warning)]"; // <10% — amber
    return "text-[var(--text-secondary)]";
  })();

  // 3.5: Liq warning banner at <15%
  const showLiqWarning = hasValidMark && liqPriceE6 > 0n && liqDistPct < 0.15;

  const pnlColor =
    pnlTokens === 0n
      ? "text-[var(--text-muted)]"
      : pnlTokens > 0n
        ? "text-[var(--long)]"
        : "text-[var(--short)]";

  const pnlBarWidth = Math.min(100, Math.max(0, Math.abs(roe)));

  // 3.1: Leverage = position notional / capital (both in same token units for stablecoin perps)
  const leverage = hasPosition && account.capital > 0n
    ? Math.round(Number(absPosition) / Number(account.capital))
    : 1;

  let marginHealthStr = "N/A";
  if (hasPosition && absPosition > 0n) {
    const healthPct = Number((account.capital * 100n) / absPosition);
    marginHealthStr = `${healthPct.toFixed(1)}%`;
  }

  // 3.4: Funding rate /8h + countdown
  const SLOTS_PER_8H = 72_000n; // 9000 slots/hr * 8
  const SLOTS_PER_SECOND = 2.5; // ~400ms per slot

  let fundingRate8hDisplay = "—";
  let fundingRateColor = "text-[var(--text-muted)]";
  let fundingCountdown = "";

  const sanitizedFundingRate = sanitizeFundingRateBps(fundingRate);
  if (hasPosition && sanitizedFundingRate !== null) {
    const rateBpsPerSlot = Number(sanitizedFundingRate);
    const slotsPerHour = 9000;
    const hourlyRatePercent = (rateBpsPerSlot * slotsPerHour) / 10000;
    const rate8hPercent = hourlyRatePercent * 8;

    const longsPay = rateBpsPerSlot > 0;
    const userPays = isLong ? longsPay : !longsPay;

    if (rateBpsPerSlot !== 0) {
      const sign = rate8hPercent >= 0 ? "+" : "-";
      fundingRate8hDisplay = `${sign}${Math.abs(rate8hPercent).toFixed(4)}%`;
      fundingRateColor = userPays ? "text-[var(--short)]" : "text-[var(--long)]";
    }

    // Countdown from lastFundingSlot
    if (engineState?.lastFundingSlot && engineState?.currentSlot) {
      const slotsSinceFunding = engineState.currentSlot - engineState.lastFundingSlot;
      const slotsLeft = SLOTS_PER_8H - slotsSinceFunding;
      const secondsLeft = slotsLeft > 0n
        ? Math.round(Number(slotsLeft) / SLOTS_PER_SECOND)
        : 0;
      fundingCountdown = `next in ${formatCountdown(secondsLeft)}`;
    }
  }

  // Legacy 24h estimate (kept for margin-health row)
  let estFunding24hDisplay = "—";
  let estFundingColor = "text-[var(--text-muted)]";
  if (hasPosition && sanitizedFundingRate !== null) {
    const rateBpsPerSlot = Number(sanitizedFundingRate);
    const slotsPerHour = 9000;
    const hourlyRatePercent = (rateBpsPerSlot * slotsPerHour) / 10000;
    const positionTokens = Number(absPosition) / (10 ** decimals);
    const est24h = Math.abs((hourlyRatePercent / 100) * 24 * positionTokens);
    const longsPay = rateBpsPerSlot > 0;
    const userPays = isLong ? longsPay : !longsPay;
    if (est24h > 0 && rateBpsPerSlot !== 0) {
      const sign = userPays ? "-" : "+";
      estFundingColor = userPays ? "text-[var(--short)]" : "text-[var(--long)]";
      estFunding24hDisplay = `${sign}${est24h < 0.0001 ? est24h.toFixed(6) : est24h.toFixed(4)} ${symbol}`;
    }
  }

  const handleConfirmClose = async (percent: number) => {
    try {
      await closePosition(percent);
      setShowCloseModal(false);
    } catch {
      // error shown via hook state
    }
  };

  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">

      {!hasPosition ? (
        /* 3.5: Improved empty state */
        <div className="p-3 flex flex-col items-center py-6 text-center">
          <p className="text-[11px] font-medium text-[var(--text-muted)]">No open position</p>
          <p className="mt-1.5 text-[10px] text-[var(--text-dim)] leading-relaxed max-w-[240px]">
            {account.capital > 0n
              ? "Open a position using the trade form."
              : "Connect wallet and trade to get started."}
          </p>
          <a
            href="#trade-form"
            className="mt-3 inline-block border border-[var(--accent)]/40 px-3 py-1 text-[10px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/[0.06]"
          >
            {account.capital > 0n ? "Open a Position" : "Trade Now →"}
          </a>
        </div>
      ) : (
        <div>
          {/* 3.1: Coloured header strip */}
          <div
            className={`flex items-center gap-2 px-3 py-2 border-l-2 ${
              isLong
                ? "border-l-[var(--long)] bg-[var(--long)]/[0.06]"
                : "border-l-[var(--short)] bg-[var(--short)]/[0.06]"
            }`}
          >
            {/* Direction arrow */}
            <span
              className={`text-[13px] leading-none ${isLong ? "text-[var(--long)]" : "text-[var(--short)]"}`}
            >
              {isLong ? "▲" : "▼"}
            </span>
            {/* Direction label */}
            <span
              className={`text-[11px] font-semibold ${isLong ? "text-[var(--long)]" : "text-[var(--short)]"}`}
            >
              {isLong ? "LONG" : "SHORT"}
            </span>
            {/* Market */}
            <span className="text-[10px] text-[var(--text-secondary)] font-mono">
              {symbol}/USD
            </span>
            {/* Leverage badge */}
            <span className="text-[8px] bg-[var(--accent)]/10 text-[var(--accent)] px-1 py-0.5">
              {leverage}x
            </span>
            {/* Spacer + CLOSE button */}
            <div className="flex-1" />
            <button
              onClick={() => setShowCloseModal(true)}
              disabled={closeLoading || lpUnderfunded || !hasValidMark}
              title={!hasValidMark ? "Waiting for price data…" : "Close position"}
              className="text-[11px] text-[var(--short)]/70 transition-colors hover:text-[var(--short)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ×
            </button>
          </div>

          <div className="p-3">
            {/* 3.2 + 3.3: PnL with ROE badge + flash animation */}
            <PnlSection
              pnlTokens={pnlTokens}
              pnlUsd={pnlUsd}
              roe={roe}
              pnlColor={pnlColor}
              pnlBarWidth={pnlBarWidth}
              hasValidMark={hasValidMark}
              symbol={symbol}
              decimals={decimals}
            />

            {/* 3.5: Liq warning when <15% away */}
            {showLiqWarning && (
              <div className="mb-2 flex items-center gap-1.5 rounded-none border border-[var(--short)]/30 bg-[var(--short)]/5 px-2 py-1.5">
                <span className="text-[8px] text-[var(--short)] font-medium uppercase tracking-[0.12em]">
                  ⚠ Liq. Risk
                </span>
                <span className="text-[9px] text-[var(--short)]/70" style={{ fontFamily: "var(--font-mono)" }}>
                  {(liqDistPct * 100).toFixed(1)}% from liq. price
                </span>
              </div>
            )}

            {/* Position details — spreadsheet rows */}
            <div className="divide-y divide-[var(--border)]/30">
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Size</span>
                <span className="text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {formatTokenAmount(absPosition, decimals)} {symbol}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Entry Price</span>
                <span className="text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {formatUsd(entryPriceE6)}
                </span>
              </div>
              {/* 3.4: Funding/8h inline — replaces the entry price row area */}
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Funding/8h</span>
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] font-medium ${fundingRateColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                    {fundingRate8hDisplay}
                  </span>
                  {fundingCountdown && (
                    <span className="text-[9px] text-[var(--text-dim)]">
                      ({fundingCountdown})
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Market Price</span>
                <span className={`text-[11px] ${hasValidMark ? "text-[var(--text)]" : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                  {hasValidMark ? formatUsd(currentPriceE6) : "--"}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Liq. Price</span>
                <span className={`text-[11px] font-medium ${liqPriceColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                  {formatLiqPrice(liqPriceE6)}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Margin Health</span>
                <span className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {marginHealthStr}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Est. Funding (24h)</span>
                <span className={`text-[11px] font-medium ${estFundingColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                  {estFunding24hDisplay}
                </span>
              </div>
            </div>

            {/* Warmup Progress (if active) */}
            <div className="mt-3 border-t border-[var(--border)] pt-3">
              <WarmupProgress
                slabAddress={slabAddress}
                accountIdx={userAccount.idx}
                tokenDecimals={decimals}
              />
            </div>

            {/* LP underfunded warning */}
            {lpUnderfunded && (
              <div className="mt-2 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-2.5">
                <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--warning)]">LP Has No Capital</p>
                <p className="mt-1 text-[10px] text-[var(--warning)]/70">
                  The liquidity provider has no capital to back the counterparty position. Closing trades will fail until the LP is funded.
                </p>
              </div>
            )}

            {/* Full close button (below the × in header) */}
            <button
              onClick={() => setShowCloseModal(true)}
              disabled={closeLoading || lpUnderfunded || !hasValidMark}
              title={!hasValidMark ? "Waiting for price data…" : undefined}
              className="mt-2 w-full rounded-none border border-[var(--short)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-all duration-150 hover:bg-[var(--short)]/8 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!hasValidMark ? "Awaiting Price…" : "Close Position"}
            </button>

            {closeError && (
              <div className="mt-2 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
                <p className="text-[10px] text-[var(--short)]">{closeError}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Close Position Modal */}
      {showCloseModal && hasPosition && (
        <ClosePositionModal
          positionSize={account.positionSize}
          entryPrice={entryPriceE6}
          currentPrice={currentPriceE6}
          capital={account.capital}
          symbol={symbol}
          decimals={decimals}
          priceUsd={priceUsd}
          isLong={isLong}
          loading={closeLoading}
          onConfirm={handleConfirmClose}
          onCancel={() => setShowCloseModal(false)}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 3.2 + 3.3: PnL section — extracted to use hooks cleanly
// ---------------------------------------------------------------------------

interface PnlSectionProps {
  pnlTokens: bigint;
  pnlUsd: number | null;
  roe: number;
  pnlColor: string;
  pnlBarWidth: number;
  hasValidMark: boolean;
  symbol: string;
  decimals: number;
}

function abs_n(n: bigint): bigint {
  return n < 0n ? -n : n;
}

const PnlSection: FC<PnlSectionProps> = ({
  pnlTokens,
  pnlUsd,
  roe,
  pnlColor,
  pnlBarWidth,
  hasValidMark,
  symbol,
  decimals,
}) => {
  // 3.2: Flash on PnL sign change
  const [flashClass, setFlashClass] = useState("");
  const prevSignRef = useRef<"pos" | "neg" | "zero">("zero");

  useEffect(() => {
    if (!hasValidMark) return;
    const sign = pnlTokens > 0n ? "pos" : pnlTokens < 0n ? "neg" : "zero";
    if (prevSignRef.current !== "zero" && prevSignRef.current !== sign) {
      const cls = sign === "pos" ? "bg-[var(--long)]/10" : "bg-[var(--short)]/10";
      setFlashClass(cls);
      const t = setTimeout(() => setFlashClass(""), 600);
      return () => clearTimeout(t);
    }
    prevSignRef.current = sign;
  }, [pnlTokens, hasValidMark]);

  return (
    <div
      className={`rounded-none border-l-2 mb-2 min-h-[60px] p-2.5 transition-colors duration-500 ${
        !hasValidMark
          ? "border-l-[var(--border)] bg-[var(--bg)]"
          : pnlTokens >= 0n
            ? "border-l-[var(--long)] bg-[var(--bg)]"
            : "border-l-[var(--short)] bg-[var(--bg)]"
      } ${flashClass}`}
    >
      <div className="flex items-start justify-between">
        <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Unrealized PnL</span>
        <div className="text-right">
          {hasValidMark ? (
            <div className="flex items-baseline gap-1.5">
              <span
                className={`text-sm font-bold ${pnlColor} tabular-nums`}
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {pnlTokens > 0n ? "+" : pnlTokens < 0n ? "-" : ""}
                {formatTokenAmount(abs_n(pnlTokens), decimals)} {symbol}
              </span>
              {pnlUsd !== null && (
                <span
                  className={`text-[10px] ${pnlColor}`}
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  ({pnlUsd >= 0 ? "+" : ""}$
                  {Math.abs(pnlUsd).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                  )
                </span>
              )}
              {/* 3.3: ROE badge inline */}
              <span
                className={`text-[10px] opacity-80 ${pnlColor}`}
                style={{ fontFamily: "var(--font-mono)" }}
              >
                ({roe >= 0 ? "+" : ""}{roe.toFixed(1)}% ROE)
              </span>
            </div>
          ) : (
            <span
              className="text-sm font-bold text-[var(--text-dim)] tabular-nums"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              --
            </span>
          )}
        </div>
      </div>
      {hasValidMark ? (
        <div className="mt-1.5 h-[2px] w-full overflow-hidden bg-[var(--border)]/50">
          <div
            className={`h-full transition-all duration-500 ${
              pnlTokens >= 0n ? "bg-[var(--long)]" : "bg-[var(--short)]"
            }`}
            style={{ width: `${pnlBarWidth}%` }}
          />
        </div>
      ) : (
        <div className="mt-1.5 text-[9px] text-[var(--text-dim)]">
          Waiting for price data…
        </div>
      )}
    </div>
  );
};
