"use client";

import { computeMarginCushion, severityFromCushion } from "@/lib/liquidation-risk";
import { FC, useMemo, useState, useRef, useEffect } from "react";
import { Q_SCALE } from "@/lib/q-usd";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useMarketConfig } from "@/hooks/useMarketConfig";
import { useClosePosition } from "@/hooks/useClosePosition";
import { useDeposit } from "@/hooks/useDeposit";
import { useWalletAtaBalance } from "@/hooks/useWalletAtaBalance";
import { checkDepositAmount, depositAmountMessage } from "@/lib/deposit-guard";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { AccountKind } from "@percolatorct/sdk";
import { formatTokenAmount, formatUsdPriceE6 } from "@/lib/format";
import { useLivePrice } from "@/hooks/useLivePrice";
import {
  computeLiqPrice,
  UNKNOWN_ENTRY_TOOLTIP,
} from "@/lib/trading";
import { terminalPositionPnl } from "@/lib/position-pnl";
import { bigintToFloat } from "@/lib/formatters";
import { DERIVED_ENTRY_TOOLTIP, ESTIMATE_LABEL, isEntryKnown } from "@/lib/entry-price-display";
import { InfoIcon } from "@/components/ui/Tooltip";
import {
  computePositionLeverage,
  describePositionLeverage,
  POSITION_LEVERAGE_LABEL,
} from "@/lib/position-leverage";
import {
  adlSideFactor,
  effectiveExposureQ,
  isDeleveraged,
  adlRemainingBps,
  adlReductionTooltip,
} from "@/lib/v17-adl";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccount } from "@/lib/mock-trade-data";
import { computeLiquidationDistancePct } from "@/lib/liquidation-distance";
import { WarmupProgress } from "./WarmupProgress";
import { useMarketFillCap } from "@/hooks/useMarketFillCap";
import { ClosePositionModal } from "./ClosePositionModal";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { sanitizeFundingRateBps, isSentinelValue } from "@/lib/health";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { useEngineFreshness } from "@/hooks/useEngineFreshness";
import { StatusLine } from "@/components/ui/StatusLine";
import { getEntryPrice, getEntryLeverage } from "@/lib/entry-price";
import { applyInvert, sanitizePriceE6 } from "@/lib/oraclePrice";
import { parseHumanAmount } from "@/lib/parseAmount";
import { isOracleStaleBlocking } from "@/lib/oracle-stale-gate";
import { computeMarginHealthPct } from "@/lib/margin-health";
import { describeLiqPrice } from "@/lib/liq-price-display";
import { LiqPriceValue } from "./LiqPriceValue";
import {
  formatLeverage,
  ORDER_LEVERAGE_TITLE,
} from "@/lib/leverage-display";

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

// ─── 5.9: Add Margin modal ────────────────────────────────────────────────────

interface AddMarginModalProps {
  slabAddress: string;
  userIdx: number;
  symbol: string;
  decimals: number;
  portfolioPk?: import("@solana/web3.js").PublicKey;
  onClose: () => void;
  onSuccess?: () => void;
}

export const AddMarginModal: FC<AddMarginModalProps> = ({ slabAddress, userIdx, symbol, decimals, portfolioPk, onClose, onSuccess}) => {
  const [amount, setAmount] = useState("");
  const [lastSig, setLastSig] = useState<string | null>(null);
  const { deposit, loading, error } = useDeposit(slabAddress);
  const { config: marginMktConfig } = useSlabState();
  const { balance: walletBalance } = useWalletAtaBalance(marginMktConfig?.collateralMint, lastSig);

  let parsedAmount: bigint = 0n;
  let parseError: string | null = null;
  if (amount) {
    try {
      parsedAmount = parseHumanAmount(amount, decimals);
    } catch {
      parseError = `Too many decimal places (max ${decimals})`;
    }
  }

  // An amount above the wallet's collateral balance is rejected inline (same
  // treatment as Withdraw) instead of being left for the chain to revert.
  const amountStatus = parseError ? "empty" : checkDepositAmount(parsedAmount, walletBalance);
  const amountError = depositAmountMessage(amountStatus, walletBalance, decimals, symbol);
  const canSubmit = !loading && amount.length > 0 && !parseError && parsedAmount > 0n && amountStatus === "ok";

  async function handleDeposit() {
    if (!canSubmit) return;
    try {
      const sig = await deposit({ userIdx, amount: parsedAmount, accountExists: true, portfolioPk });
      setLastSig(sig ?? null);
      setAmount("");

    // Add margin mutates the slab account. Refresh immediately so capital,
    // liquidation risk, and position health do not stay stale until polling.
    onSuccess?.();
    } catch {
      // error shown via hook
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Add margin"
    >
      <div className="w-full max-w-sm rounded-none border border-[var(--border)]/60 bg-[var(--bg)] p-4 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-[var(--text)]">Add Margin</span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--text-secondary)] hover:text-[var(--text)] transition-colors"
          >
            ×
          </button>
        </div>

        <p className="mb-3 text-[10px] text-[var(--text-secondary)] leading-relaxed">
          Deposit additional collateral to increase your margin and reduce liquidation risk.
        </p>

        <div className="mb-2 flex flex-col gap-1">
          <label className="text-[9px] uppercase tracking-[0.12em] text-[var(--text)]">
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
          {!parseError && amountError && (
            <p role="alert" data-testid="add-margin-amount-error" className={`text-[10px] ${amountStatus === "exceeds" ? "text-[var(--short)]" : "text-[var(--text-secondary)]"}`}>
              {amountError}
            </p>
          )}
          {walletBalance !== null && walletBalance > 0n && (
            <button
              type="button"
              onClick={() => setAmount(formatTokenAmount(walletBalance, decimals))}
              className="self-start text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] hover:underline"
            >
              Max: {formatTokenAmount(walletBalance, decimals, 3)} {symbol}
            </button>
          )}
        </div>

        <button
          onClick={handleDeposit}
          disabled={!canSubmit}
          className="w-full rounded-none bg-[var(--accent)] py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-white transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Depositing…" : "Deposit Margin"}
        </button>

        {error && (
          <p className="mt-2 text-[10px] text-[var(--short)]">{error}</p>
        )}
        {lastSig && (
          <p className="mt-2 text-[10px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
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
  const { accounts, config: mktConfig, params, adlFactors, wrapperConfigV17, refresh: refreshSlab } = useSlabState();
  const { priceE6: livePriceE6, priceUsd } = useLivePrice();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const mintAddress = mktConfig?.collateralMint?.toBase58() ?? "";
  const collateralSymbol = sanitizeSymbol(tokenMeta?.symbol, mintAddress);
  const { market: marketInfo } = useMarketInfo(slabAddress);
  const symbol = marketInfo?.symbol ?? collateralSymbol;
  const decimals = tokenMeta?.decimals ?? 6;

  const { closePosition, loading: closeLoading, error: closeError, prewarmClose } = useClosePosition(slabAddress);
  // Per-trade fill cap — the close modal uses it to explain multi-fill closes.
  const fillCaps = useMarketFillCap(slabAddress);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [showAddMarginModal, setShowAddMarginModal] = useState(false);

  // GH#1842: Oracle staleness check — mirrors TradeForm guard
  // H7: "keeper" added to the mode set — this gate previously only fired for
  // admin/hyperp markets, so a stale keeper-priced market (all 5 live
  // playground markets) never blocked closing.
  const { level: oracleLevel, mode: oracleMode, ready: oracleReady } = useOracleFreshness();
  const oracleUnavailable = oracleLevel === "unavailable";
  const oracleStale = !mockMode && (oracleUnavailable || isOracleStaleBlocking(oracleLevel, oracleMode, oracleReady));
  // H6: engine accrue-staleness — distinct from the oracle-push freshness
  // above. A market can look perfectly fresh here (keeper still pushing
  // prices) while the ENGINE hasn't accrued in ~500 slots, cliff-dead and
  // permanently reverting every close (UX WP-2: only beyond the app's own catch-up). See
  // useEngineFreshness's file header.
  const { engineStale } = useEngineFreshness();
  const closeBlockedByStaleness = !mockMode && (oracleStale || engineStale);

  const lpEntry = useMemo(() => {
    return accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null;
  }, [accounts]);

  // Bug #267a67ef: LP with 0 capital cannot accept counterparty positions
  const lpUnderfunded = lpEntry !== null && lpEntry.account.capital === 0n;

  if (!userAccount) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex flex-col items-center py-6 text-center">
          <p className="text-[11px] font-medium text-[var(--text)]">No open position</p>
          <p className="mt-1.5 text-[10px] text-[var(--text-secondary)] leading-relaxed max-w-[240px]">
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
  // ADL scales the asset's shared per-side factor and never rewrites the leg's
  // basis, so raw `positionSize` is the NOMINAL size. `absPosition` is the
  // exposure actually carried — size, notional-for-display and funding all
  // follow it. See lib/v17-adl.ts.
  const aSide = adlFactors ? adlSideFactor(adlFactors, isLong ? 0 : 1) : 0n;
  const wasDeleveraged = !!adlFactors && isDeleveraged(account.adlABasis, aSide);
  const adlRemaining = adlFactors ? adlRemainingBps(account.adlABasis, aSide) : 10000;
  /** Nominal basis — margin and closing are denominated in it, not in exposure. */
  const absNominal = abs(account.positionSize);
  // Apply invert + sanitize on the on-chain fallback so an inverted market
  // doesn't show the reciprocal price during WS reconnects (~$0.0000067 vs $150).
  const onChainPriceE6 = config
    ? sanitizePriceE6(applyInvert(config.lastEffectivePriceE6, config.invert))
    : null;
  const currentPriceE6 = livePriceE6 ?? onChainPriceE6 ?? 0n;

  const initialMarginBps = params?.initialMarginBps ?? 1000n;
  // PERC-297: Mark price is considered "available" when it's a positive value.
  const hasValidMark = currentPriceE6 > 0n;
  // ONE shared computation for every PnL surface (lib/position-pnl.ts, #3077).
  // 2026-07-22: substituting the mark when no entry is known implies a flat
  // position, and on v17 that is exactly the wrong guess (a realized loss is
  // crystallized out of `capital` and `pnl` reset to 0, v16.rs:9382-9437) - so an
  // unknown entry, or unknown ADL factors, is `pnlKnown: false` and renders "--".
  // The entry is cache/server/back-solved OVER EFFECTIVE SIZE (it used to be raw
  // basis here), valued at the mark; exposure is ADL-effective, never a raw fallback.
  const pnlResult = terminalPositionPnl({
    account,
    slabAddress,
    accountIdx: userAccount.idx,
    adlFactors,
    adlApplicable: wrapperConfigV17 !== null,
    markE6: currentPriceE6,
    anchorMarkE6: onChainPriceE6 ?? undefined,
    initialMarginBps,
  });
  const effectiveSize = pnlResult.effectiveSize ?? account.positionSize;
  const absPosition = abs(effectiveSize);
  const entryPriceE6 = pnlResult.entry;
  const pnlIsKnown = pnlResult.pnlKnown;
  /** The entry itself is real (server/cache/estimate), even if PnL is withheld. */
  const entryKnown = isEntryKnown(pnlResult.entry, pnlResult.entrySource);
  // Native (coin-margined) PnL is what this panel's "<n> SYMBOL" line shows; the
  // $ figure is the collateral-scale PnL (the same number the dock/bar/badge show).
  const pnlTokens = pnlResult.pnlNative ?? 0n;
  const pnlUsdRaw = pnlResult.unrealizedPnl !== null ? bigintToFloat(pnlResult.unrealizedPnl, decimals) : null;
  const pnlUsd = pnlUsdRaw !== null && Number.isFinite(pnlUsdRaw) ? pnlUsdRaw : null;
  const roe = pnlResult.roe ?? 0;

  const maintenanceBps = params?.maintenanceMarginBps ?? 500n;
  const liqPriceE6 = computeLiqPrice(
    entryPriceE6,
    account.capital,
    account.positionSize,
    maintenanceBps,
  );

  // Liq price color and banner use the site-wide warning tiers: the share of this
  // position's margin cushion left (lib/liquidation-risk.ts), not a flat distance.
  const liqTier = (() => {
    if (account.positionSize === 0n || !hasValidMark) return "safe" as const;
    const cushion = computeMarginCushion({
      positionSize: account.positionSize,
      entryPriceE6,
      capital: account.capital,
      markPriceE6: currentPriceE6,
      maintenanceMarginBps: maintenanceBps,
      initialMarginBps,
    });
    return cushion == null ? ("safe" as const) : severityFromCushion(cushion);
  })();
  // The distance shown in the banner. Direction-aware (shared helper): a short whose mark has crossed ABOVE its
  // liq price is distance 0 (critical), not "safe" — the old
  // Math.abs(cur-liq)/cur showed a crossed position as far from liquidation.
  // Helper returns percent 0-100; thresholds below consume a 0-1 fraction.
  const liqDistPct = (() => {
    if (liqPriceE6 <= 0n || !hasValidMark || currentPriceE6 <= 0n) return Infinity;
    return computeLiquidationDistancePct(account.positionSize, currentPriceE6, liqPriceE6) / 100;
  })();

  // Long-side clamp: liq at/below $0 with a resolved entry = cannot be
  // liquidated by price (excess collateral) — a SAFE state, not a warning.
  const liqUnliquidatable = liqPriceE6 <= 0n && entryPriceE6 > 0n && account.positionSize !== 0n;

  const liqPriceColor = (() => {
    if (liqUnliquidatable) return "text-[var(--text-secondary)]";
    if (liqPriceE6 <= 0n || !hasValidMark || currentPriceE6 <= 0n) return "text-[var(--warning)]";
    if (liqTier === "danger") return "text-[var(--short)]";
    if (liqTier === "warning") return "text-[var(--warning)]";
    return "text-[var(--text-secondary)]";
  })();

  const showLiqWarning = hasValidMark && liqPriceE6 > 0n && liqTier !== "safe";
  const liqWarningTone = liqTier === "danger" ? "var(--short)" : "var(--warning)";

  const pnlColor =
    pnlTokens === 0n
      ? "text-[var(--text-muted)]"
      : pnlTokens > 0n
        ? "text-[var(--long)]"
        : "text-[var(--short)]";

  const pnlBarWidth = Math.min(100, Math.max(0, Math.abs(roe)));

  // Leverage = notional / equity (capital + pnl) on the cross-margined
  // portfolio — the CURRENT effective figure (lib/position-leverage.ts), not
  // entry leverage (the chain stores none). Notional is NOMINAL on purpose: the
  // engine still charges margin against the leg's full basis after ADL
  // (`risk_notional_ceil(leg.basis_pos_q…)`, v16.rs:9707), so the reduced
  // exposure would render a deleveraged position as SAFER than it is — the
  // same unsafe direction lib/v17-engine-config.ts was written to eliminate.
  const leverageDisplay = describePositionLeverage(
    computePositionLeverage({
      sizeQ: hasPosition ? account.positionSize : 0n,
      markPriceE6: currentPriceE6 > 0n ? currentPriceE6 : null,
      capital: account.capital,
      pnl: account.pnl,
      collateralDecimals: decimals,
    }),
  );
  // The order-ticket slider value is a local-only memory of what the user
  // picked, shown separately and labelled as such.
  const savedOrderLeverage = getEntryLeverage(slabAddress, userAccount.idx, account.owner.toBase58());

  // Shared with the other four surfaces that show a liquidation price — this
  // was the only one computing it. Nominal size, not ADL-reduced exposure:
  // see the note above notionalE6 and lib/margin-health.ts.
  const marginHealthPct = computeMarginHealthPct(account.capital, absNominal, currentPriceE6);
  const marginHealthStr = marginHealthPct == null ? "N/A" : `${marginHealthPct.toFixed(1)}%`;
  const liqDisplay = describeLiqPrice({
    liqPriceE6,
    positionSize: account.positionSize,
    capital: account.capital,
    markPriceE6: currentPriceE6,
    maintenanceMarginBps: maintenanceBps,
    // #2660: `entryPriceE6 > 0n` is always true — on "unknown" it is the mark.
    hasResolvedEntry: pnlIsKnown,
  });

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
    // Q units (POS_SCALE 1e6), not the collateral mint's decimals
    const positionTokens = Number(absPosition) / Q_SCALE;
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
          <p className="text-[11px] font-medium text-[var(--text)]">No open position</p>
          <p className="mt-1.5 text-[10px] text-[var(--text-secondary)] leading-relaxed max-w-[240px]">
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
            {/* Leverage badge: current effective (cross-margin) leverage */}
            <span
              className="text-[8px] bg-[var(--accent)]/10 text-[var(--accent)] px-1 py-0.5"
              title={leverageDisplay.title}
              data-testid="position-leverage-badge"
            >
              {POSITION_LEVERAGE_LABEL} {leverageDisplay.text}
            </span>
            {/* Spacer + CLOSE button */}
            <div className="flex-1" />
            <button
              onClick={() => { prewarmClose(); setShowCloseModal(true); }}
              disabled={closeLoading || lpUnderfunded || !hasValidMark || engineStale}
              title={!hasValidMark ? "Waiting for price data…" : engineStale ? "Prices are catching up. Closing resumes once the market has caught up." : "Close position"}
              aria-label="Close position"
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
              pnlIsKnown={pnlIsKnown}
              isEstimate={pnlResult.isEstimate}
              pnlColor={pnlColor}
              pnlBarWidth={pnlBarWidth}
              hasValidMark={hasValidMark}
              symbol={symbol}
              decimals={decimals}
            />

            {/* Liq warning at the site-wide tiers, in the same tone and words as the site-wide card */}
            {showLiqWarning && (
              <div
                className="mb-2 flex items-center gap-1.5 rounded-none border px-2 py-1.5"
                style={{
                  borderColor: `color-mix(in srgb, ${liqWarningTone} 30%, transparent)`,
                  background: `color-mix(in srgb, ${liqWarningTone} 5%, transparent)`,
                }}
                data-severity={liqTier}
              >
                <span className="text-[8px] font-medium uppercase tracking-[0.12em]" style={{ color: liqWarningTone }}>
                  {liqTier === "danger" ? "Liquidation risk" : "Approaching liquidation"}
                </span>
                <span className="text-[9px] opacity-70" style={{ fontFamily: "var(--font-mono)", color: liqWarningTone }}>
                  {(liqDistPct * 100).toFixed(1)}% from liq. price
                </span>
              </div>
            )}

            {/* Position details — spreadsheet rows */}
            <div className="divide-y divide-[var(--border)]/30">
              {/* 5.8: Dual contract+USD size */}
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Size</span>
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-[11px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>
                    {formatTokenAmount(absPosition, decimals)} {symbol}
                    {wasDeleveraged && (
                      <span
                        className="ml-1 inline-block rounded-sm bg-[var(--short)]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-[var(--short)]"
                        title={adlReductionTooltip(absNominal, absPosition, adlRemaining, decimals, symbol)}
                      >
                        ADL
                      </span>
                    )}
                  </span>
                  {wasDeleveraged && (
                    <span className="text-[10px] text-[var(--short)]">
                      reduced from {formatTokenAmount(absNominal, decimals)} {symbol}
                    </span>
                  )}
                  {priceUsd != null && priceUsd > 0 && (
                    <span className="text-[10px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                      ${(Number(absPosition) / Q_SCALE * priceUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Entry Price</span>
                <span className={`text-[11px] ${entryKnown ? "text-[var(--text)]" : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                  {entryKnown ? formatUsdPriceE6(entryPriceE6) : (
                    <span className="inline-flex items-center gap-1">
                      --
                      <InfoIcon tooltip={UNKNOWN_ENTRY_TOOLTIP} />
                    </span>
                  )}
                </span>
              </div>
              {/* 3.4: Funding/8h inline — replaces the entry price row area */}
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Funding/8h</span>
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] font-medium ${fundingRateColor}`} style={{ fontFamily: "var(--font-mono)" }}>
                    {fundingRate8hDisplay}
                  </span>
                  {fundingCountdown && (
                    <span className="text-[9px] text-[var(--text-secondary)]">
                      ({fundingCountdown})
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Market Price</span>
                <span className={`text-[11px] ${hasValidMark ? "text-[var(--text)]" : "text-[var(--text-dim)]"}`} style={{ fontFamily: "var(--font-mono)" }}>
                  {hasValidMark ? formatUsdPriceE6(currentPriceE6) : "--"}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Liq. Price</span>
                <LiqPriceValue
                  display={liqDisplay}
                  className={`text-[11px] font-medium ${liqPriceColor}`}
                  style={{ fontFamily: "var(--font-mono)" }}
                />
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Margin Health</span>
                <span className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {marginHealthStr}
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="inline-flex items-center text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">
                  {POSITION_LEVERAGE_LABEL}
                  <InfoIcon tooltip={leverageDisplay.title} />
                </span>
                <span className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                  {leverageDisplay.text}
                </span>
              </div>
              {savedOrderLeverage != null && (
                <div className="flex items-center justify-between py-1.5">
                  <span className="inline-flex items-center text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">
                    Order Lev.
                    <InfoIcon tooltip={ORDER_LEVERAGE_TITLE} />
                  </span>
                  <span className="text-[11px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                    {formatLeverage(savedOrderLeverage)}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between py-1.5">
                <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Est. Funding (24h)</span>
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
                <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--warning)]">Market out of liquidity</p>
                <p className="mt-1 text-[10px] text-[var(--warning)]/70">
                  The market has no liquidity to take the other side right now, so closing can't go through until it is refilled.
                </p>
              </div>
            )}

            {/* UX WP-2 (SH-3): only a lag beyond the app's own catch-up; clears itself. */}
            {engineStale && !oracleStale && (
              <StatusLine
                className="mt-2"
                legacyTestId="engine-stale-warning"
                message={{ kind: "engine-catching-up", variant: "wait", title: "Catching up", body: "Prices are catching up. Closing resumes once the market has caught up." }}
              />
            )}

            {/* 5.9: Add Margin + Close buttons */}
            <div className="mt-2 flex gap-1.5">
              <button
                onClick={() => setShowAddMarginModal(true)}
                className="flex-1 rounded-none border border-[var(--accent)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] transition-colors duration-150 hover:bg-[var(--accent)]/8"
              >
                + Margin
              </button>
              <button
                onClick={() => { prewarmClose(); setShowCloseModal(true); }}
                disabled={closeLoading || lpUnderfunded || !hasValidMark || engineStale}
                title={!hasValidMark ? "Waiting for price data…" : engineStale ? "Prices are catching up. Closing resumes once the market has caught up." : undefined}
                className="flex-1 rounded-none border border-[var(--short)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-colors duration-150 hover:bg-[var(--short)]/8 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {!hasValidMark ? "Awaiting Price…" : engineStale ? "Waiting for prices…" : "Close Position"}
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
          // EFFECTIVE exposure for the close preview (#3077); the close re-reads the leg.
          positionSize={effectiveSize}
          entryPrice={pnlIsKnown ? entryPriceE6 : 0n}
          currentPrice={currentPriceE6}
          capital={account.capital}
          symbol={symbol}
          collateralSymbol={collateralSymbol}
          decimals={decimals}
          priceUsd={priceUsd}
          isLong={isLong}
          loading={closeLoading}
          // Defense-in-depth: the panel's own Close button above is already
          // disabled on engineStale (with its own correctly-labeled title),
          // but if the modal is somehow already open when engine-staleness
          // is detected, keep its Confirm button blocked too.
          oracleStale={closeBlockedByStaleness}
          maxFillAbs={fillCaps?.maxFillAbs ?? null}
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
          portfolioPk={userAccount.pubkey}
          onClose={() => setShowAddMarginModal(false)}
        onSuccess={refreshSlab}
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
  /** False when entry price is unrecoverable, so `pnlTokens` is a placeholder
   *  zero rather than a real flat reading — see resolveEntryPrice. */
  pnlIsKnown: boolean;
  /** PnL rests on a back-solved entry - label it "est.". */
  isEstimate?: boolean;
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
  pnlIsKnown,
  isEstimate,
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
        <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Unrealized PnL</span>
        <div className="text-right">
          {!pnlIsKnown ? (
            <span
              className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-dim)] tabular-nums"
              style={{ fontFamily: "var(--font-mono)" }}
            >
              --
              <InfoIcon tooltip={UNKNOWN_ENTRY_TOOLTIP} />
            </span>
          ) : hasValidMark ? (
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
                  ({pnlUsd >= 0 ? "+" : "-"}$
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
              {isEstimate && (
                <span className="text-[9px] text-[var(--text-dim)]" title={DERIVED_ENTRY_TOOLTIP}>{ESTIMATE_LABEL}</span>
              )}
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
            className={`h-full transition-[width,background-color] duration-500 ${
              pnlTokens >= 0n ? "bg-[var(--long)]" : "bg-[var(--short)]"
            }`}
            style={{ width: `${pnlBarWidth}%` }}
          />
        </div>
      ) : (
        <div className="mt-1.5 text-[9px] text-[var(--text-secondary)]">
          Waiting for price data…
        </div>
      )}
    </div>
  );
};
