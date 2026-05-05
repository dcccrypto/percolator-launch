"use client";

import { FC, useMemo, useState, useRef, useEffect, useCallback } from "react";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useDeposit } from "@/hooks/useDeposit";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { AccountKind } from "@percolatorct/sdk";
import { formatTokenAmount, formatUsdPriceE6, formatLiqPrice } from "@/lib/format";
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
import { sanitizeFundingRateBps, isSentinelValue } from "@/lib/health";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { getEntryPrice, getEntryLeverage, clearEntryPrice } from "@/lib/entry-price";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import { getBackendUrl } from "@/lib/config";
import { parseHumanAmount } from "@/lib/parseAmount";
import {
  formatLeverage,
  ORDER_LEVERAGE_TITLE,
  RISK_LEVERAGE_LABEL,
  RISK_LEVERAGE_TITLE,
} from "@/lib/leverage-display";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

// ─── 5.7: ADL rank for this user's position slot ─────────────────────────────

interface AdlRankResult {
  rank: number | null;      // null = not in rankings (safe)
  adlNeeded: boolean;
}

function useAdlRank(slabAddress: string, positionIdx: number | null): AdlRankResult {
  const [result, setResult] = useState<AdlRankResult>({ rank: null, adlNeeded: false });

  const fetch_ = useCallback(async () => {
    if (positionIdx === null) return;
    try {
      const base = getBackendUrl();
      const res = await fetch(`${base}/api/adl/rankings?slab=${encodeURIComponent(slabAddress)}`);
      if (!res.ok) return;
      const json = await res.json() as {
        adlNeeded: boolean;
        rankings: { rank: number; idx: number }[];
      };
      const entry = json.rankings.find((r) => r.idx === positionIdx);
      setResult({ rank: entry?.rank ?? null, adlNeeded: json.adlNeeded });
    } catch {
      // non-critical — leave last known value
    }
  }, [slabAddress, positionIdx]);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, 30_000);
    return () => clearInterval(id);
  }, [fetch_]);

  return result;
}

// ─── 5.9: Add Margin modal ────────────────────────────────────────────────────

interface AddMarginModalProps {
  slabAddress: string;
  userIdx: number;
  symbol: string;
  decimals: number;
  onClose: () => void;
}

const AddMarginModal: FC<AddMarginModalProps> = ({ slabAddress, userIdx, symbol, decimals, onClose }) => {
  const [amount, setAmount] = useState("");
  const [lastSig, setLastSig] = useState<string | null>(null);
  const { deposit, loading, error } = useDeposit(slabAddress);

  let parsedAmount: bigint = 0n;
  let parseError: string | null = null;
  if (amount) {
    try {
      parsedAmount = parseHumanAmount(amount, decimals);
    } catch {
      parseError = `Too many decimal places (max ${decimals})`;
    }
  }

  const canSubmit = !loading && amount.length > 0 && !parseError && parsedAmount > 0n;

  async function handleDeposit() {
    if (!canSubmit) return;
    try {
      const sig = await deposit({ userIdx, amount: parsedAmount, accountExists: true });
      setLastSig(sig ?? null);
      setAmount("");
    } catch {
      // error shown via hook
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm rounded-none border border-[var(--border)]/60 bg-[var(--bg)] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-[var(--text)]">Add Margin</span>
          <button
            onClick={onClose}
            className="text-[var(--text-dim)] hover:text-[var(--text)] transition-colors"
          >
            ×
          </button>
        </div>

        <p className="mb-3 text-[10px] text-[var(--text-dim)] leading-relaxed">
          Deposit additional collateral to increase your margin and reduce liquidation risk.
        </p>

        <div className="mb-2 flex flex-col gap-1">
          <label className="text-[9px] uppercase tracking-[0.12em] text-[var(--text-dim)]">
            Amount ({symbol})
          </label>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder={`0.00 ${symbol}`}
            style={{ fontFamily: "var(--font-mono)" }}
            className="w-full rounded-none border border-[var(--border)]/50 bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
          />
          {parseError && (
            <p className="text-[10px] text-[var(--short)]">{parseError}</p>
          )}
        </div>

        <button
          onClick={handleDeposit}
          disabled={!canSubmit}
          className="w-full rounded-none bg-[var(--accent)] py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Depositing…" : "Deposit Margin"}
        </button>

        {error && (
          <p className="mt-2 text-[10px] text-[var(--short)]">{error}</p>
        )}
        {lastSig && (
          <p className="mt-2 text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
            Tx: {lastSig.slice(0, 16)}…
          </p>
        )}
      </div>
    </div>
  );
};

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
  const collateralSymbol = sanitizeSymbol(tokenMeta?.symbol, mintAddress);
  const { market: marketInfo } = useMarketInfo(slabAddress);
  const symbol = marketInfo?.symbol ?? collateralSymbol;
  const decimals = tokenMeta?.decimals ?? 6;

  const { closePosition, loading: closeLoading, error: closeError } = useClosePosition(slabAddress);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showAddMarginModal, setShowAddMarginModal] = useState(false);

  // GH#1842: Oracle staleness check — mirrors TradeForm guard
  const { level: oracleLevel, mode: oracleMode, ready: oracleReady } = useOracleFreshness();
  const oracleUnavailable = oracleLevel === "unavailable";
  const oracleStale = !mockMode && (oracleUnavailable || (oracleReady && oracleLevel === "stale" && (oracleMode === "admin" || oracleMode === "hyperp")));

  // 5.7: ADL rank — fetch once account is known; positionIdx = userAccount.idx
  const adlPositionIdx = userAccount ? userAccount.idx : null;
  const { rank: adlRank, adlNeeded } = useAdlRank(slabAddress, adlPositionIdx);

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
  // Apply invert + sanitize on the on-chain fallback so an inverted market
  // doesn't show the reciprocal price during WS reconnects (~$0.0000067 vs $150).
  const onChainPriceE6 = config
    ? sanitizePriceE6(applyInvert(config.lastEffectivePriceE6, config.invert))
    : null;
  const currentPriceE6 = livePriceE6 ?? onChainPriceE6 ?? 0n;

  // V12_1: entry_price removed from on-chain struct. Fall back to saved entry price.
  const rawEntryPrice = account.entryPrice;
  const savedEntryPrice = rawEntryPrice > 0n ? 0n : getEntryPrice(slabAddress, userAccount.idx);
  const resolvedEntryPrice = rawEntryPrice > 0n ? rawEntryPrice : (savedEntryPrice > 0n ? savedEntryPrice : 0n);
  const entryPriceE6 = resolvedEntryPrice > 0n ? resolvedEntryPrice : currentPriceE6;

  // PERC-297: Mark price is considered "available" when it's a positive value.
  const hasValidMark = currentPriceE6 > 0n;

  // PnL: prefer mark-to-market from entry price (on-chain or saved),
  // fall back to on-chain realized PnL if neither is available.
  const pnlTokens = hasValidMark
    ? (resolvedEntryPrice > 0n
        ? computeMarkPnl(account.positionSize, resolvedEntryPrice, currentPriceE6)
        : (isSentinelValue(account.pnl) ? 0n : account.pnl))
    : 0n;
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

  // 3.1: Leverage = notional / capital. Notional = contracts × markPrice / 1e6.
  // Old formula used raw contract count which gives ~0 for coin-margined positions.
  const notionalE6 = absPosition * currentPriceE6;
  const accountLeverage = hasPosition && account.capital > 0n && currentPriceE6 > 0n
    ? Number(notionalE6 / 1_000_000n) / Number(account.capital)
    : 0;
  const savedOrderLeverage = getEntryLeverage(slabAddress, userAccount.idx);
  const displayLeverage = savedOrderLeverage ?? accountLeverage;
  const displayLeverageKind = savedOrderLeverage != null ? "Order" : "Risk";
  const leverageTitle = savedOrderLeverage != null
    ? `${ORDER_LEVERAGE_TITLE} ${RISK_LEVERAGE_LABEL} is ${formatLeverage(accountLeverage)} because all collateral in this slab account backs liquidation.`
    : RISK_LEVERAGE_TITLE;

  let marginHealthStr = "N/A";
  if (hasPosition && notionalE6 > 0n) {
    const healthPct = Number(account.capital * 1_000_000n * 100n / notionalE6);
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
    // /100 converts bps → percent (GH#1943: was /10000 causing 10,000x underreport)
    const hourlyRatePercent = (rateBpsPerSlot * slotsPerHour) / 100;
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
    // /100 converts bps → percent (GH#1943: was /10000 causing 10,000x underreport)
    const hourlyRatePercent = (rateBpsPerSlot * slotsPerHour) / 100;
    const positionTokens = Number(absPosition) / (10 ** decimals);
    // hourlyRatePercent is already in percent; /100 converts to fraction for est24h
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
      if (percent === 100 && userAccount) clearEntryPrice(slabAddress, userAccount.idx);
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
            <span
              className="text-[8px] bg-[var(--accent)]/10 text-[var(--accent)] px-1 py-0.5"
              title={leverageTitle}
            >
              {displayLeverageKind} {formatLeverage(displayLeverage)}
            </span>
            {/* 5.7: ADL rank indicator */}
            <AdlRankBadge rank={adlRank} adlNeeded={adlNeeded} />
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
              {/* 5.8: Dual contract+USD size */}
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Size</span>
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                    {formatTokenAmount(absPosition, decimals)} {symbol}
                  </span>
                  {priceUsd != null && priceUsd > 0 && (
                    <span className="text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
                      ${(Number(absPosition) / 10 ** decimals * priceUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Entry Price</span>
                <span className="text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {formatUsdPriceE6(entryPriceE6)}
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
                  {hasValidMark ? formatUsdPriceE6(currentPriceE6) : "--"}
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
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]" title={RISK_LEVERAGE_TITLE}>
                  {RISK_LEVERAGE_LABEL}
                </span>
                <span className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {formatLeverage(accountLeverage)}
                </span>
              </div>
              {savedOrderLeverage != null && (
                <div className="flex items-center justify-between py-1.5">
                  <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]" title={ORDER_LEVERAGE_TITLE}>
                    Order Lev.
                  </span>
                  <span className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                    {formatLeverage(savedOrderLeverage)}
                  </span>
                </div>
              )}
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

            {/* 5.9: Add Margin + Close buttons */}
            <div className="mt-2 flex gap-1.5">
              <button
                onClick={() => setShowAddMarginModal(true)}
                className="flex-1 rounded-none border border-[var(--accent)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] transition-all duration-150 hover:bg-[var(--accent)]/8"
              >
                + Margin
              </button>
              <button
                onClick={() => setShowCloseModal(true)}
                disabled={closeLoading || lpUnderfunded || !hasValidMark}
                title={!hasValidMark ? "Waiting for price data…" : undefined}
                className="flex-1 rounded-none border border-[var(--short)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-all duration-150 hover:bg-[var(--short)]/8 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {!hasValidMark ? "Awaiting Price…" : "Close Position"}
              </button>
            </div>

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
          collateralSymbol={collateralSymbol}
          decimals={decimals}
          priceUsd={priceUsd}
          isLong={isLong}
          loading={closeLoading}
          oracleStale={oracleStale}
          onConfirm={handleConfirmClose}
          onCancel={() => setShowCloseModal(false)}
        />
      )}

      {/* 5.9: Add Margin Modal */}
      {showAddMarginModal && hasPosition && (
        <AddMarginModal
          slabAddress={slabAddress}
          userIdx={userAccount.idx}
          symbol={symbol}
          decimals={decimals}
          onClose={() => setShowAddMarginModal(false)}
        />
      )}
    </div>
  );
};

// ─── 5.7: ADL rank badge ──────────────────────────────────────────────────────

function AdlRankBadge({ rank, adlNeeded }: { rank: number | null; adlNeeded: boolean }) {
  if (!adlNeeded && rank === null) return null;

  // Color: rank <= 3 is high risk (red), rank <= 10 yellow, rest green
  const color =
    rank !== null && rank <= 3
      ? "bg-[var(--short)] border-[var(--short)]/50 text-white"
      : rank !== null && rank <= 10
        ? "bg-[var(--warning)] border-[var(--warning)]/50 text-[var(--bg)]"
        : "bg-[var(--long)] border-[var(--long)]/50 text-white";

  const label =
    rank !== null
      ? `ADL #${rank}`
      : adlNeeded
        ? "ADL Safe"
        : null;

  if (!label) return null;

  const tooltip =
    rank !== null && rank <= 3
      ? "High ADL risk — position may be auto-deleveraged soon"
      : rank !== null && rank <= 10
        ? "Moderate ADL risk — monitor insurance fund utilization"
        : "ADL active but your position is relatively safe";

  return (
    <span
      title={tooltip}
      className={`inline-flex items-center gap-0.5 rounded-none border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.06em] ${color}`}
    >
      {label}
    </span>
  );
}

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
