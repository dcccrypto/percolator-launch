"use client";

/**
 * Phase 4 (trade-terminal rebuild): the new order ticket.
 *
 * Field order per the brief: Long/Short segmented ->
 * size input (unit toggle + 25/50/75/Max chips) -> leverage slider+input ->
 * receipt (entry, liq price, fees, slippage, margin req, before->after) ->
 * ONE big full-width Long(green)/Short(red) button -> account row (balance,
 * buying power, deposit link). Single-severity-gated validation (dYdX
 * priority-pipeline model, `perp-dex-reference-patterns.md` Area 4).
 *
 * SAFETY: every calculation and submission path here is a direct port of
 * `components/trade/TradeForm.tsx`'s proven logic (dual-size-input sync
 * math, on-chain-authoritative leverage cap derivation, the guard
 * conditions, the confirm-snapshot pattern, the `handleTrade` submission
 * flow) — restructured into this component's presentation and the single
 * size-input/validation-pipeline shape the brief asks for, but NOT
 * reimplemented from scratch. `useTrade`/`useUserAccount`/
 * `useOracleFreshness` are called exactly as TradeForm already calls them;
 * `useDeposit` is wired via `DepositWithdrawCard` (TradeForm's own existing
 * deposit path, same component, same hook underneath — not re-derived).
 * The on-chain instruction this submits (`trade()` -> `TradeCpi`) is
 * byte-identical to what TradeForm sends today.
 *
 * Market-only: this ticket no longer offers a Limit tab (removed — it
 * shipped with a defect cluster: a receipt/confirm-modal "worst fill price"
 * that was actually always mark-derived regardless of the typed limit, a
 * sub-micro-price sentinel that could silently disable slippage protection,
 * and broken sub-$1 formatting). Percolator's `TradeCpi` has no resting/
 * pending order concept anyway — `trade()` always executes immediately;
 * `limitPriceE6` is purely a worst-acceptable-fill-price bound (slippage
 * protection). `useTrade` is left to derive that bound from the live mark
 * (via `computeLimitPriceE6`, unchanged) exactly as it already did for a
 * market order — nothing about that path changes here.
 */

import { FC, memo, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useTrade } from "@/hooks/useTrade";
import { humanizeError, withTransientRetry } from "@/lib/errorMessages";
import { explorerTxUrl, getNetwork } from "@/lib/config";
import { useUserAccount } from "@/hooks/useUserAccount";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { getLivePriceSnapshot } from "@/lib/priceStore/priceStore";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { AccountKind, computePreTradeLiqPrice, computeLiqPrice } from "@percolatorct/sdk";
import { computeEstimatedEntryPrice, computeTradingFee, computePositionInitialMargin, estimateEntryFromPnl } from "@/lib/trading";
import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";
import { InfoIcon } from "@/components/ui/Tooltip";
import { usePrivyLogin } from "@/hooks/usePrivySafe";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccountIdle } from "@/lib/mock-trade-data";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { formatTokenAmount, formatUsdPriceE6, toE6 } from "@/lib/format";
import { saveEntryPrice, getEntryPrice, clearEntryPrice } from "@/lib/entry-price";
import { DepositWithdrawCard } from "@/components/trade/DepositWithdrawCard";
import { useInitUser } from "@/hooks/useInitUser";

const LEVERAGE_SNAP_POINTS = [1, 3, 5, 10, 20];
const SIZE_PRESETS = [25, 50, 75, 100];
const MAX_DISPLAY_LEVERAGE = 200;

function parsePercToNative(input: string, decimals = 6): bigint {
  const parts = input.split(".");
  if (parts.length > 2) return 0n;
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac);
}

/* ── Single-severity-gated validation (dYdX priority-pipeline model) ──
 * Priority-ordered: protocol-level blocks first, user-input issues last.
 * Only the FIRST (highest-priority) issue renders as the single banner;
 * only `error`-severity issues block submit (matches the reference doc's
 * two-severity model — warnings display but don't disable the button). */
interface TicketValidationCtx {
  marketPaused: boolean;
  vaultEmpty: boolean;
  lpUnderfunded: boolean;
  riskGateActive: boolean;
  oracleUnavailable: boolean;
  oracleStale: boolean;
  hasPrice: boolean;
  mockMode: boolean;
  exceedsBalance: boolean;
  balanceLabel: string;
}
interface ValidationIssue {
  severity: "error" | "warning";
  title: string;
  message: string;
}
function buildValidationIssues(ctx: TicketValidationCtx): ValidationIssue[] {
  if (ctx.mockMode) return [];
  const issues: ValidationIssue[] = [];
  if (ctx.marketPaused) {
    issues.push({ severity: "error", title: "Market paused", message: "Trading, deposits, and withdrawals are disabled by the market admin." });
  }
  if (ctx.vaultEmpty) {
    issues.push({ severity: "error", title: "No vault liquidity", message: "This market has no LP deposits. Trading will be enabled once liquidity is added to the vault." });
  }
  if (ctx.lpUnderfunded) {
    issues.push({ severity: "error", title: "Liquidity unavailable", message: "The LP has no capital. Trades cannot execute until the LP is funded." });
  }
  if (ctx.riskGateActive) {
    issues.push({ severity: "error", title: "Risk reduction mode", message: "This market is in de-risking mode. Only closing trades are allowed right now." });
  }
  if (ctx.oracleUnavailable) {
    issues.push({ severity: "error", title: "Oracle unavailable", message: "Oracle not yet active - keeper has not cranked this market." });
  } else if (ctx.oracleStale) {
    issues.push({ severity: "error", title: "Oracle stale", message: "The oracle price for this market has not updated recently. Trading is temporarily disabled to prevent failed transactions." });
  }
  if (!ctx.hasPrice) {
    issues.push({ severity: "error", title: "No oracle price", message: "Waiting for price feed. Trades will be enabled once oracle data is available." });
  }
  if (ctx.exceedsBalance) {
    issues.push({ severity: "error", title: "Exceeds balance", message: `Order size exceeds your available balance (${ctx.balanceLabel}).` });
  }
  return issues;
}

function DiffRow({
  label,
  before,
  after,
  valueClass = "text-[var(--text)]",
  tooltip,
}: {
  label: string;
  before: string;
  after: string;
  valueClass?: string;
  tooltip?: string;
}) {
  const changed = before !== after;
  return (
    <div className="flex items-center justify-between py-1 text-[10px]">
      <span className="flex items-center gap-1 text-[var(--text-secondary)] uppercase tracking-[0.08em]">
        {label}
        {tooltip && <InfoIcon tooltip={tooltip} />}
      </span>
      <span className="flex items-center gap-1 font-mono tabular-nums">
        {changed && <span className="text-[var(--text-secondary)] line-through decoration-[var(--text-secondary)]/50">{before}</span>}
        {changed && <span className="text-[var(--text-secondary)]">→</span>}
        <span className={valueClass}>{after}</span>
      </span>
    </div>
  );
}

/**
 * Follow-up to Phase 4/5 (trade-terminal rebuild) — closes the one caveat
 * BUILD-LOG.md carried forward: OrderTicket is now memoized the same way
 * `TradingChart` (Phase 2) and `PositionsDock` (Phase 5) are.
 *
 * The precondition Phase 1 established (`useTrade`/`useClosePosition` read
 * price via the store's non-reactive `getLivePriceSnapshot()`, never a
 * reactive subscription) applies here too: this component no longer calls
 * the reactive `useLivePrice()` hook at all. Every `priceUsd`/`priceE6` read
 * below (receipt math, size-unit conversion, validation, and the submit-time
 * worst-fill-price calc) goes through `getLivePriceSnapshot(slabAddress)` —
 * a plain, non-subscribing function call, not a hook — so a price tick
 * cannot, by itself, be the thing that re-renders this component. It's still
 * called on every render (there's no way around needing a value for the
 * receipt JSX), so it stays "as fresh as the last render" the same way
 * `TradingChart`'s non-reactive fallback reads already do (see that file's
 * Phase 2 header comment) — good enough for a live preview, and the
 * genuinely submit-critical read (the worst-fill-price shown in the confirm
 * modal, see the main submit button's onClick below) re-fetches a FRESH
 * snapshot at the moment of building that snapshot rather than trusting a
 * potentially-stale render-scoped value, i.e. "read at submit" in the most
 * literal sense for the one value where it actually matters.
 *
 * `OrderTicket`'s only prop is a stable string (`slabAddress`, unchanged
 * except on an actual market switch) — same shallow-equality justification
 * `TradingChart`/`PositionsDock` already documented, no custom comparator
 * needed.
 */
const OrderTicketInner: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { connected: walletConnected, publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const connected = walletConnected || mockMode;
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccountIdle(slabAddress) : null);
  const { trade, loading, error } = useTrade(slabAddress);
  const { engine, params, insuranceBalance: liveInsuranceBalance, totalOI: liveTotalOI, hasData: engineHasData } = useEngineState();
  const { accounts, config: mktConfig, header, refresh: refreshSlab } = useSlabState();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  // Non-reactive — see file-header comment. NOT `useLivePrice()`.
  const { priceUsd, priceE6: livePriceE6 } = getLivePriceSnapshot(slabAddress);
  const { level: oracleLevel, mode: oracleMode, ready: oracleReady } = useOracleFreshness();
  const oracleUnavailable = oracleLevel === "unavailable";
  const oracleStale = !oracleUnavailable && oracleReady && oracleLevel === "stale" && (oracleMode === "admin" || oracleMode === "hyperp");
  const openWalletModal = usePrivyLogin();
  const mintAddress = mktConfig?.collateralMint?.toBase58() ?? "";
  const collateralSymbol = sanitizeSymbol(tokenMeta?.symbol, mintAddress);

  const [onChainDecimals, setOnChainDecimals] = useState<number | null>(null);
  const decimals = onChainDecimals ?? tokenMeta?.decimals ?? 6;
  const [walletAtaBalance, setWalletAtaBalance] = useState<bigint | null>(null);

  const riskThreshold = params?.riskReductionThreshold ?? 0n;
  const vaultBalance = engine?.vault ?? 0n;
  const insuranceBalance = engine?.insuranceFund?.balance ?? 0n;
  const riskGateActive = riskThreshold > 0n && vaultBalance <= riskThreshold;
  const isHyperp = mktConfig?.oracleAuthority?.toBase58() === "11111111111111111111111111111111";
  // BUG 21 fix: `engine` is always null on v17 (legacy block; see useEngineState /
  // SlabProvider), so an `engine !== null` gate here was dead — a drained-vault v17
  // market never tripped the "No vault liquidity" block. v17 has no vault-capital
  // field in the parsed slab state at all, so fall back to the group-level insurance
  // reserve + total OI (both v17-available via parseMarketGroupV17OI, exposed as
  // useEngineState().insuranceBalance/totalOI): if the market has ever carried an
  // insurance reserve OR currently has open interest, liquidity clearly exists. Only
  // flag "no liquidity" once real v17 data has loaded and both read zero — a
  // stale/loading read must not falsely block trading, but also must not keep
  // showing a fake-green "tradable" state forever.
  const vaultEmpty = engine !== null
    ? vaultBalance === 0n && insuranceBalance === 0n && !isHyperp && !mockMode
    : engineHasData && liveInsuranceBalance != null && liveTotalOI != null
      ? liveInsuranceBalance === 0n && liveTotalOI === 0n && !isHyperp && !mockMode
      : false;

  const [direction, setDirection] = useState<"long" | "short">("long");
  // USD is the default sizing unit — traders think in dollar notional first;
  // the chip next to the input switches to token units for those who don't.
  const [sizeUnit, setSizeUnit] = useState<"token" | "usd">("usd");
  const [sizeInput, setSizeInput] = useState("");
  const [marginInput, setMarginInput] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [leverageText, setLeverageText] = useState("1");
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [tradePhase, setTradePhase] = useState<"idle" | "submitting" | "confirming">("idle");
  const [humanError, setHumanError] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmSnapshot, setConfirmSnapshot] = useState<{
    positionSize: bigint;
    marginNative: bigint;
    estimatedLiqPrice: bigint;
    tradingFee: bigint;
    worstFillPriceE6: bigint;
  } | null>(null);
  const [showInlineDeposit, setShowInlineDeposit] = useState(false);
  const [oneClickEnabled, setOneClickEnabled] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const val = localStorage.getItem("percolator-one-click-trading");
      if (val === "true") setOneClickEnabled(true);
    }
  }, []);

  const handleOneClickToggle = (val: boolean) => {
    setOneClickEnabled(val);
    if (typeof window !== "undefined") {
      localStorage.setItem("percolator-one-click-trading", val ? "true" : "false");
    }
  };

  // Keyboard shortcuts: Shift+L for Long, Shift+S for Short
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") {
        return;
      }
      if (e.shiftKey && e.key.toUpperCase() === "L") {
        e.preventDefault();
        setDirection("long");
      } else if (e.shiftKey && e.key.toUpperCase() === "S") {
        e.preventDefault();
        setDirection("short");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Which tab the inline card opens on. Clicking the active trigger closes the
  // card; clicking the other trigger switches its tab in place.
  const [inlineDepositMode, setInlineDepositMode] = useState<"deposit" | "withdraw">("deposit");
  const toggleInlineDeposit = (target: "deposit" | "withdraw") => {
    if (showInlineDeposit && inlineDepositMode === target) {
      setShowInlineDeposit(false);
      return;
    }
    setInlineDepositMode(target);
    setShowInlineDeposit(true);
  };

  const { initUser, loading: initLoading, error: initError } = useInitUser(slabAddress);
  const [initCtaError, setInitCtaError] = useState<string | null>(null);

  const lpEntry = useMemo(() => accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null, [accounts]);
  const lpIdx = lpEntry?.idx ?? 0;
  const hasValidLP = lpEntry !== null;
  const lpUnderfunded = hasValidLP && lpEntry!.account.capital === 0n;

  const { market: marketInfo } = useMarketInfo(slabAddress);
  const symbol = marketInfo?.symbol ?? collateralSymbol;
  const initialMarginBps = params?.initialMarginBps ?? 1000n;
  const maintenanceMarginBps = params?.maintenanceMarginBps ?? 500n;
  const tradingFeeBps = params?.tradingFeeBps ?? 30n;
  const maxLeverageFromOnChain = initialMarginBps > 0n ? Math.max(1, Number(10000n / initialMarginBps)) : 0;
  const supabaseLeverage = Number(marketInfo?.max_leverage) || 0;
  const rawMaxLeverage = maxLeverageFromOnChain > 0 ? maxLeverageFromOnChain : supabaseLeverage || 1;
  const maxLeverage = Math.min(MAX_DISPLAY_LEVERAGE, rawMaxLeverage);

  const availableLeverage = useMemo(() => {
    const arr = LEVERAGE_SNAP_POINTS.filter((l) => l <= maxLeverage);
    if (arr.length === 0 || arr[arr.length - 1] < maxLeverage) arr.push(maxLeverage);
    return arr;
  }, [maxLeverage]);

  const capital = userAccount ? userAccount.account.capital : 0n;
  // Margin already "locked" by this market's existing open position (if
  // any), so balance/buying-power reflect what's actually free to size a
  // NEW order with — not the account's full collateral, which is already
  // backing the current position. Uses the position's OWN entry/size (same
  // entry-price resolution PositionsDock/ChartPnlBadge already do: on-chain
  // entry_price -> locally-cached entry from this trade's open -> the
  // on-chain-pnl-implied entry for a Position NFT received via transfer),
  // never the pending order's inputs, and the same
  // notional/initialMarginBps basis this ticket already uses for
  // maxLeverage/liq-price everywhere else.
  const existingPositionSize = userAccount?.account.positionSize ?? 0n;
  const rawExistingEntryPrice = userAccount?.account.entryPrice ?? 0n;
  const cachedExistingEntryPrice = userAccount && rawExistingEntryPrice === 0n
    ? getEntryPrice(slabAddress, userAccount.idx, publicKey?.toBase58())
    : 0n;
  const existingEntryPriceE6 = rawExistingEntryPrice > 0n
    ? rawExistingEntryPrice
    : cachedExistingEntryPrice > 0n
      ? cachedExistingEntryPrice
      : userAccount
        ? estimateEntryFromPnl(existingPositionSize, userAccount.account.pnl, livePriceE6 ?? 0n)
        : 0n;
  const lockedMargin = computePositionInitialMargin(existingPositionSize, existingEntryPriceE6, initialMarginBps);
  const availableBalance = userAccount ? (capital > lockedMargin ? capital - lockedMargin : 0n) : 0n;
  const effectiveBalance = userAccount ? availableBalance : (walletAtaBalance ?? 0n);
  // Buying power: how large a position (in collateral notional) the user could
  // open at the current max leverage with their full AVAILABLE (not total)
  // balance — capital already locked by an open position can't back a
  // second one too.
  const buyingPower = effectiveBalance * BigInt(Math.max(1, Math.round(maxLeverage)));

  useEffect(() => {
    if (!publicKey || !mktConfig?.collateralMint || mockMode) {
      setOnChainDecimals(null);
      setWalletAtaBalance(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(mktConfig.collateralMint, publicKey);
        const info = await connection.getTokenAccountBalance(ata);
        if (!cancelled) {
          if (info.value.decimals !== undefined) setOnChainDecimals(info.value.decimals);
          if (info.value.amount) setWalletAtaBalance(BigInt(info.value.amount));
        }
      } catch {
        if (!cancelled) { setOnChainDecimals(null); setWalletAtaBalance(null); }
      }
    })();
    return () => { cancelled = true; };
    // BUG 10 fix: `capital` and `showInlineDeposit` are lastSig-style refresh
    // triggers (mirrors DepositWithdrawCard's own `lastSig` dependency on its
    // twin wallet-balance effect, DepositWithdrawCard.tsx:69) — without them this
    // only ran once at mount, so "Wal Bal" (and the `hasWalletTokens` onboarding
    // CTA derived from it below) froze at the mount-time value forever. `capital`
    // changes on-chain whenever this account's deposit/withdraw completes.
    // `showInlineDeposit` toggling closed is this component's only available
    // signal for the inline DepositWithdrawCard's own deposit/withdraw/faucet-mint
    // (its tx signature isn't exposed to this component) — re-fetching on that
    // transition unfreezes the value instead of requiring a full page remount.
  }, [publicKey, mktConfig?.collateralMint, connection, mockMode, capital, showInlineDeposit]);

  // Reset form state on market switch (mirrors TradeForm's bug #1a12dab5 fix).
  useEffect(() => {
    setDirection("long");
    setSizeInput("");
    setMarginInput("");
    setLeverage(1);
    setLeverageText("1");
    setLastSig(null);
    setHumanError(null);
    setTradePhase("idle");
  }, [slabAddress]);

  // ── Single size input, unit-toggled (token <-> USD) ──
  // Same derivation math as TradeForm's dual-input sync, just driven by one
  // field + a mode flag instead of two simultaneous fields.
  const recomputeFromSize = useCallback(
    (raw: string, unit: "token" | "usd", lev: number) => {
      const n = parseFloat(raw);
      if (isNaN(n) || !priceUsd || priceUsd <= 0) {
        setMarginInput("");
        return;
      }
      const notionalUsd = unit === "token" ? n * priceUsd : n;
      const marginAmt = notionalUsd / lev;
      setMarginInput(marginAmt.toFixed(decimals));
    },
    [priceUsd, decimals],
  );

  const handleSizeChange = useCallback(
    (val: string) => {
      const cleaned = val.replace(/[^0-9.]/g, "");
      setSizeInput(cleaned);
      recomputeFromSize(cleaned, sizeUnit, leverage);
    },
    [sizeUnit, leverage, recomputeFromSize],
  );

  const toggleSizeUnit = useCallback(() => {
    setSizeUnit((prev) => {
      const next = prev === "token" ? "usd" : "token";
      const n = parseFloat(sizeInput);
      if (!isNaN(n) && priceUsd && priceUsd > 0) {
        const converted = prev === "token" ? n * priceUsd : n / priceUsd;
        const nextStr = next === "token" ? converted.toFixed(6) : converted.toFixed(2);
        setSizeInput(nextStr);
        recomputeFromSize(nextStr, next, leverage);
      }
      return next;
    });
  }, [sizeInput, priceUsd, leverage, recomputeFromSize]);

  const updateLeverage = useCallback(
    (newLev: number) => {
      setLeverage(newLev);
      setLeverageText(String(newLev));
      if (sizeInput) recomputeFromSize(sizeInput, sizeUnit, newLev);
    },
    [sizeInput, sizeUnit, recomputeFromSize],
  );

  const setSizePercent = useCallback(
    (pct: number) => {
      if (effectiveBalance <= 0n) return;
      let marginAmount = (effectiveBalance * BigInt(pct)) / 100n;
      if (marginAmount === 0n && pct > 0) marginAmount = 1n;
      const marginStr = formatTokenAmount(marginAmount, decimals);
      setMarginInput(marginStr);
      const marginNum = Number(marginAmount) / Math.pow(10, decimals);
      const notionalUsd = marginNum * leverage;
      if (priceUsd && priceUsd > 0) {
        const nextSize = sizeUnit === "token" ? notionalUsd / priceUsd : notionalUsd;
        setSizeInput(sizeUnit === "token" ? nextSize.toFixed(6) : nextSize.toFixed(2));
      }
    },
    [effectiveBalance, decimals, leverage, priceUsd, sizeUnit],
  );

  // Listen to order book price clicks to auto-calculate/populate size input
  useEffect(() => {
    const handleBookClick = (e: Event) => {
      const customEvt = e as CustomEvent<{ price: number; type: "bid" | "ask" | "oracle" }>;
      const clickPrice = customEvt.detail.price;
      const type = customEvt.detail.type;

      if (type === "bid") setDirection("long");
      if (type === "ask") setDirection("short");

      if (clickPrice > 0 && effectiveBalance > 0n) {
        const balNum = Number(effectiveBalance) / Math.pow(10, decimals);
        const maxNotionalUsd = balNum * leverage;
        const val = sizeUnit === "token" ? (maxNotionalUsd / clickPrice).toFixed(6) : maxNotionalUsd.toFixed(2);
        setSizeInput(val);
        recomputeFromSize(val, sizeUnit, leverage);
      }
    };
    window.addEventListener("percolator-book-click", handleBookClick);
    return () => window.removeEventListener("percolator-book-click", handleBookClick);
  }, [effectiveBalance, decimals, leverage, sizeUnit, recomputeFromSize]);

  const marginNative = marginInput ? parsePercToNative(marginInput, decimals) : 0n;
  const notionalNative = marginNative * BigInt(leverage);
  const rawPositionSize = livePriceE6 && livePriceE6 > 0n ? (notionalNative * 1_000_000n) / livePriceE6 : 0n;
  const positionSize = rawPositionSize < 0n ? 0n : rawPositionSize;
  const exceedsBalance = marginNative > 0n && marginNative > effectiveBalance;

  // ── Receipt (before -> after) ──
  const oracleE6 = priceUsd ? toE6(priceUsd) : 0n;
  const hasOrder = marginNative > 0n && positionSize > 0n && !exceedsBalance;
  const estEntry = hasOrder ? computeEstimatedEntryPrice(oracleE6, tradingFeeBps, direction) : 0n;
  const fee = hasOrder ? computeTradingFee((positionSize * oracleE6) / 1_000_000n, tradingFeeBps) : 0n;
  const afterLiqPrice = hasOrder
    ? computePreTradeLiqPrice(oracleE6, marginNative, positionSize, maintenanceMarginBps, tradingFeeBps, direction)
    : 0n;
  const beforeLiqPrice = userAccount && userAccount.account.positionSize !== 0n && userAccount.account.entryPrice > 0n
    ? computeLiqPrice(userAccount.account.entryPrice, userAccount.account.capital, userAccount.account.positionSize, maintenanceMarginBps)
    : 0n;
  // BUG 9 fix: opening a position RESERVES margin from existing capital — it is
  // not a deposit — so this must show capital -> capital MINUS the reserved
  // margin (what's left available), never capital + marginNative, which
  // fabricated a higher post-trade balance (e.g. "100 -> 120 USDC").
  const beforeMargin = capital;
  const afterMargin = beforeMargin > marginNative ? beforeMargin - marginNative : 0n;
  // Slippage: distance between the mark and the worst acceptable fill
  // (same computeLimitPriceE6 useTrade itself uses to derive the on-chain
  // limit when the caller doesn't supply one explicitly).
  const signedSizeForSlippage = direction === "short" ? -positionSize : positionSize;
  let slippageBoundE6 = 0n;
  try {
    slippageBoundE6 = hasOrder && livePriceE6 && livePriceE6 > 0n
      ? computeLimitPriceE6({ markE6: livePriceE6, size: signedSizeForSlippage })
      : 0n;
  } catch {
    slippageBoundE6 = 0n;
  }

  // Dispatch pending TP/SL price projections to TradingChart
  useEffect(() => {
    if (typeof window === "undefined") return;

    if (!hasOrder || !priceUsd || priceUsd <= 0 || leverage <= 0) {
      window.dispatchEvent(new CustomEvent("percolator-pending-tpsl", {
        detail: { hasOrder: false, tp50: null, tp100: null, sl25: null, sl50: null }
      }));
      return;
    }

    const entryNum = Number(estEntry) / 1e6;
    
    // Math formulas:
    // TP +50%: targetExitPrice = entryNum * (1 + 0.5 / leverage)
    const tp50 = direction === "long" ? entryNum * (1 + 0.5 / leverage) : entryNum * (1 - 0.5 / leverage);
    const tp100 = direction === "long" ? entryNum * (1 + 1.0 / leverage) : entryNum * (1 - 1.0 / leverage);
    const sl25 = direction === "long" ? entryNum * (1 - 0.25 / leverage) : entryNum * (1 + 0.25 / leverage);
    const sl50 = direction === "long" ? entryNum * (1 - 0.5 / leverage) : entryNum * (1 + 0.5 / leverage);

    window.dispatchEvent(new CustomEvent("percolator-pending-tpsl", {
      detail: { hasOrder: true, tp50, tp100, sl25, sl50 }
    }));
  }, [hasOrder, estEntry, leverage, direction, priceUsd]);

  // ── Validation (single banner, priority-ordered) ──
  const validationIssues = buildValidationIssues({
    marketPaused: !!header?.paused,
    vaultEmpty,
    lpUnderfunded,
    riskGateActive,
    oracleUnavailable,
    oracleStale,
    hasPrice: priceUsd != null,
    mockMode,
    exceedsBalance,
    balanceLabel: `${formatTokenAmount(effectiveBalance, decimals)} ${collateralSymbol}`,
  });
  const blockingIssue = validationIssues.find((i) => i.severity === "error") ?? null;

  const needsWallet = !connected;
  const needsAccount = connected && !userAccount;
  const needsDeposit = connected && userAccount && capital === 0n;

  // snapshotSize must be UNSIGNED (magnitude only). Direction sign is applied
  // internally: `direction === "short" ? -effectiveSize : effectiveSize`.
  async function handleTrade(snapshotSize?: bigint) {
    const effectiveSize = snapshotSize ?? positionSize;
    if (!marginInput || !userAccount || effectiveSize <= 0n || exceedsBalance) return;

    if (mockMode) {
      setTradePhase("submitting");
      setTimeout(() => { setTradePhase("confirming"); setMarginInput(""); setSizeInput(""); }, 800);
      setTimeout(() => setTradePhase("idle"), 2000);
      return;
    }
    if (!connected) {
      setHumanError("Wallet disconnected. Please reconnect your wallet.");
      return;
    }

    setHumanError(null);
    setTradePhase("submitting");
    try {
      const size = direction === "short" ? -effectiveSize : effectiveSize;
      // limitPriceE6 omitted — useTrade derives it from the live mark (its
      // existing, unchanged market-order behaviour — see hooks/useTrade.ts).
      const sig = await withTransientRetry(
        async () => trade({ lpIdx, userIdx: userAccount!.idx, size }),
        { maxRetries: 2, delayMs: 3000 },
      );
      setTradePhase("confirming");
      setLastSig(sig ?? null);
      setMarginInput("");
      setSizeInput("");
      if (livePriceE6 && livePriceE6 > 0n && userAccount) {
        const wallet = publicKey?.toBase58();
        // BUG 9 fix: this fired unconditionally on every successful open, so
        // scaling INTO (or reducing/flipping through) an EXISTING position
        // overwrote the cached entry with this trade's raw fill price — not
        // a blended cost basis — corrupting Entry/Liq/PnL/ROE everywhere that
        // reads the cache. Only a genuinely NEW position (flat -> open) has
        // "this fill IS the entry" be true. When a position already existed
        // pre-trade, clear the now-stale cache instead: every consumer's
        // existing `cachedEntry > 0 ? cached : estimateEntryFromPnl(...)`
        // fallback then recovers the correct basis from the refreshed
        // on-chain size/pnl (accurate once refreshSlab() below lands)
        // instead of showing this trade's fill price mislabeled as "Entry".
        if (existingPositionSize === 0n) {
          saveEntryPrice(slabAddress, userAccount.idx, livePriceE6, leverage, wallet);
        } else {
          clearEntryPrice(slabAddress, userAccount.idx, wallet);
        }
      }
      setTimeout(() => {
        refreshSlab();
        setTradePhase("idle");
      }, 1500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[OrderTicket] raw error:", msg);
      setHumanError(humanizeError(msg));
      setTradePhase("idle");
    }
  }

  const submitDisabled =
    tradePhase !== "idle" ||
    loading ||
    !marginInput ||
    positionSize <= 0n ||
    !!blockingIssue;

  return (
    <div className="relative p-3.5">
      {/* Long / Short segmented — semantic long/short tokens only, symmetric
          unselected states (both read as neutral until chosen — previously
          Short's idle state was tinted red even when not selected, which
          fought the "green/red are semantic, not decorative" rule and made
          the two buttons visually asymmetric at rest). */}
      <div className="mb-3 flex gap-1">
        <button
          onClick={() => setDirection("long")}
          aria-pressed={direction === "long"}
          className={`flex-1 rounded-none border py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-colors duration-150 ${
            direction === "long"
              ? "border-[var(--long)] bg-[var(--long)] text-black"
              : "border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--long)]/40 hover:text-[var(--text)]"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setDirection("short")}
          aria-pressed={direction === "short"}
          className={`flex-1 rounded-none border py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-colors duration-150 ${
            direction === "short"
              ? "border-[var(--short)] bg-[var(--short)] text-white"
              : "border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--short)]/40 hover:text-[var(--text)]"
          }`}
        >
          Short
        </button>
      </div>

      {/* Size — single input + unit toggle + quick-fill chips */}
      <div className="mb-2">
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">
            Size
            <InfoIcon tooltip="Position size in the toggled unit. Switch between token and USD - both stay in sync." />
          </label>
          {/* Both balances up top — users deposit from the wallet into the
              account and trade from the account; showing only one confused
              people about where their funds "went". 3dp keeps the row tight.
              "Acc Bal" is AVAILABLE capital (total minus margin already
              locked by an open position on this market) — when a position
              is open it shows "avail / total" so the locked portion isn't
              hidden, just no longer double-counted as spendable. */}
          <span
            className="text-[10px] text-[var(--text)]"
            style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
            title={lockedMargin > 0n ? `${formatTokenAmount(lockedMargin, decimals, 3)} ${collateralSymbol} locked by your open position on this market` : undefined}
          >
            <span className="text-[var(--text-secondary)]">Acc Bal </span>
            {userAccount ? formatTokenAmount(availableBalance, decimals, 3) : "0"}
            {lockedMargin > 0n && (
              <span className="text-[var(--text-secondary)]">/{formatTokenAmount(capital, decimals, 3)}</span>
            )}
            <span className="text-[var(--text-secondary)]"> · Wal Bal </span>
            {walletAtaBalance != null ? formatTokenAmount(walletAtaBalance, decimals, 3) : "—"}
            <span className="text-[var(--text-secondary)]"> {collateralSymbol}</span>
          </span>
        </div>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={sizeInput}
            onChange={(e) => handleSizeChange(e.target.value)}
            placeholder={sizeUnit === "token" ? "0.000000" : "$0.00"}
            style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
            className={`flex-1 rounded-none border px-2 py-2 text-right text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:border-[var(--accent)] focus:ring-[var(--accent)]/20 ${
              exceedsBalance ? "border-[var(--short)]/50 bg-[var(--short)]/5" : "border-[var(--border)]/40 bg-[var(--bg)]"
            }`}
          />
          <button
            onClick={toggleSizeUnit}
            className="w-16 shrink-0 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors duration-150 hover:border-[var(--border-hover)] hover:text-[var(--text)]"
          >
            {sizeUnit === "token" ? symbol : "USD"}
          </button>
        </div>
        {exceedsBalance && (
          <p className="mt-1 text-[10px] text-[var(--short)]" style={{ fontFamily: "var(--font-mono)" }}>
            Exceeds balance ({formatTokenAmount(effectiveBalance, decimals)} {collateralSymbol})
          </p>
        )}
      </div>
      <div className="mb-3 flex gap-1">
        {SIZE_PRESETS.map((pct) => (
          <button
            key={pct}
            onClick={() => setSizePercent(pct)}
            className="flex-1 rounded-none border border-[var(--border)]/30 py-1 text-[10px] font-medium text-[var(--text-secondary)] transition-colors duration-150 hover:border-[var(--accent)]/30 hover:bg-[var(--accent-subtle)] hover:text-[var(--text)]"
          >
            {pct === 100 ? "Max" : `${pct}%`}
          </button>
        ))}
      </div>

      {/* Leverage — unified snapping slider with tick marks */}
      <div className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">
            Leverage
            <InfoIcon tooltip="The multiplier used to size this order. On-chain margin params are the authoritative cap." />
          </label>
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={leverageText}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.]/g, "");
                setLeverageText(raw);
                const parsed = parseFloat(raw);
                if (!isNaN(parsed)) updateLeverage(Math.max(1, Math.min(maxLeverage, Math.round(parsed))));
              }}
              onBlur={() => setLeverageText(String(leverage))}
              style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
              className="w-12 rounded-none border border-[var(--border)]/50 bg-[var(--bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--text)] focus:border-[var(--accent)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
            />
            <span className="text-[11px] font-medium text-[var(--text)]">x</span>
          </div>
        </div>
        {maxLeverage > 1 ? (() => {
          const n = availableLeverage.length;

          // Maps a leverage value → uniform display % (interpolates between snap-point indices)
          const valueToPct = (val: number): number => {
            if (n <= 1) return 0;
            for (let i = 0; i < n - 1; i++) {
              if (val <= availableLeverage[i + 1]) {
                const lo = availableLeverage[i], hi = availableLeverage[i + 1];
                return ((i + (hi > lo ? (val - lo) / (hi - lo) : 0)) / (n - 1)) * 100;
              }
            }
            return 100;
          };

          const thumbPct = valueToPct(leverage);
          const snapRadius = n > 1
            ? Math.floor(Math.min(...availableLeverage.slice(1).map((v, i) => v - availableLeverage[i])) / 2)
            : 0;

          return (
            <div className="relative pt-1 pb-1">
              {/* Custom visual track — 3px tall */}
              <div className="relative mx-0 h-[3px] rounded-full bg-[var(--border)]/30 mt-2">
                {/* Fill */}
                <div
                  className="absolute left-0 top-0 h-full rounded-full bg-[var(--accent)]"
                  style={{ width: `${thumbPct}%` }}
                />
                {/* Custom thumb — follows valueToPct, not the native linear position */}
                <div
                  className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)] ring-2 ring-[var(--accent)]/30"
                  style={{ left: `${thumbPct}%` }}
                />
              </div>
              {/* Invisible native input — full value range, handles all drag/click */}
              <input
                type="range"
                min={1}
                max={maxLeverage}
                step={1}
                value={leverage}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  const nearest = availableLeverage.reduce((best, v) =>
                    Math.abs(v - raw) < Math.abs(best - raw) ? v : best, raw);
                  updateLeverage(Math.abs(nearest - raw) <= snapRadius ? nearest : raw);
                }}
                className="absolute inset-x-0 top-0 h-full w-full cursor-pointer opacity-0"
                aria-label="Leverage"
              />
              {/* Labels — uniformly spaced, one per snap point */}
              <div className="mt-2 flex justify-between">
                {availableLeverage.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => updateLeverage(l)}
                    className={`text-[8px] font-mono transition-colors duration-100 ${
                      leverage === l
                        ? "text-[var(--accent)] font-bold"
                        : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
                    }`}
                  >
                    {l}x
                  </button>
                ))}
              </div>
            </div>
          );
        })() : (
          <p className="text-[9px] text-[var(--text-dim)] font-mono">{maxLeverage}x (fixed)</p>
        )}
      </div>






      {/* Receipt — before -> after. Deliberately "sunken" (var(--bg), the
          page-level darkness, rather than an elevated surface) so it reads
          as an inset readout inside the ticket panel — a small depth cue
          that reinforces the panel/ticket as the raised surface. */}
      {hasOrder && (
        <div className="mb-3 rounded-none border border-[var(--border)]/60 bg-[var(--bg)]/60 px-2.5 py-2 divide-y divide-[var(--border)]/30">
          <DiffRow label="Entry" before="—" after={formatUsdPriceE6(estEntry)} />
          <DiffRow
            label="Liq price"
            before={beforeLiqPrice > 0n ? formatUsdPriceE6(beforeLiqPrice) : "—"}
            after={afterLiqPrice > 0n ? formatUsdPriceE6(afterLiqPrice) : "—"}
            valueClass={direction === "long" ? "text-[var(--short)]" : "text-[var(--long)]"}
            tooltip="Estimated liquidation price if this order fills at the estimated entry."
          />
          <DiffRow label="Fees" before="—" after={`${formatTokenAmount(fee, decimals)} ${collateralSymbol}`} />
          <DiffRow
            label="Slippage bound"
            before="—"
            after={slippageBoundE6 > 0n ? formatUsdPriceE6(slippageBoundE6) : "—"}
            tooltip="Worst acceptable fill price sent on-chain - the trade reverts rather than fill worse than this."
          />
          <DiffRow
            label="Margin req."
            before={`${formatTokenAmount(beforeMargin, decimals)} ${collateralSymbol}`}
            after={`${formatTokenAmount(afterMargin, decimals)} ${collateralSymbol}`}
            tooltip="Margin reserved from your account balance to back this position — not a deposit, so your balance after opening is lower, not higher."
          />
          {afterLiqPrice > 0n && (
            <div className="flex items-center justify-between py-1 text-[10px]">
              <span className="flex items-center gap-1 text-[var(--text-secondary)] uppercase tracking-[0.08em]">
                Risk Level
                <InfoIcon tooltip="The estimated risk of liquidation based on the distance between the oracle price and your liquidation price." />
              </span>
              {(() => {
                const mark = livePriceE6 ?? oracleE6;
                const liq = afterLiqPrice;
                if (mark <= 0n || liq <= 0n) return <span className="text-[var(--text-dim)] font-mono">N/A</span>;
                const pct = mark > 0n ? Math.abs(Number(mark - liq)) / Number(mark) : 0;
                // barPct: distance-to-liq as a 0–100 gauge (40%+ distance = 100% "safe")
                const barPct = Math.min(100, Math.max(0, (pct / 0.4) * 100));

                let label = "Low";
                let colorClass = "text-emerald-400 border-emerald-400/30 bg-emerald-400/5";
                let barColor = "bg-emerald-400";

                if (pct < 0.05) {
                  label = "Critical";
                  colorClass = "text-red-500 border-red-500/30 bg-red-500/5 font-bold animate-pulse";
                  barColor = "bg-red-500";
                } else if (pct < 0.15) {
                  label = "High";
                  colorClass = "text-red-400 border-red-400/30 bg-red-400/5";
                  barColor = "bg-red-400";
                } else if (pct < 0.30) {
                  label = "Medium";
                  colorClass = "text-amber-400 border-amber-400/30 bg-amber-400/5";
                  barColor = "bg-amber-400";
                }
                
                return (
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-12 bg-[var(--border)]/20 overflow-hidden rounded-sm hidden xs:block">
                      <div className={`h-full ${barColor}`} style={{ width: `${barPct}%` }} />
                    </div>
                    <span className={`px-1.5 py-0.5 rounded-sm border text-[9px] font-medium uppercase tracking-[0.05em] ${colorClass}`}>
                      {label}
                    </span>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* Single validation banner (highest-priority issue only) */}
      {blockingIssue && (
        <div className="mb-3 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">{blockingIssue.title}</p>
          <p className="mt-1 text-[9px] leading-relaxed text-[var(--text-secondary)]">{blockingIssue.message}</p>
        </div>
      )}

      {/* One-click trading option */}
      {connected && !needsAccount && !needsDeposit && (
        <div className="mb-3 flex items-center justify-between">
          <label htmlFor="one-click-trade" className="flex items-center gap-1.5 cursor-pointer text-[10px] text-[var(--text-secondary)] uppercase tracking-[0.08em]">
            <input
              id="one-click-trade"
              type="checkbox"
              checked={oneClickEnabled}
              onChange={(e) => handleOneClickToggle(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            One-Click Trading
          </label>
        </div>
      )}

      {/* ONE big full-width submit */}
      {needsWallet ? (
        <button
          onClick={() => openWalletModal()}
          className="w-full rounded-none bg-[var(--accent)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-[filter] duration-150 hover:brightness-110"
        >
          Connect Wallet
        </button>
      ) : needsAccount || needsDeposit ? (
        <>
          {(() => {
            const hasWalletTokens = (walletAtaBalance ?? 0n) > 0n;
            const canOneClick = needsAccount && hasWalletTokens && !showInlineDeposit;
            const onClickDirect = async () => {
              setInitCtaError(null);
              try {
                await initUser(0n);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (!/user rejected|cancelled|denied/i.test(msg)) setInitCtaError(msg);
              }
            };
            return (
              <button
                onClick={canOneClick ? onClickDirect : () => setShowInlineDeposit((v) => !v)}
                disabled={initLoading}
                className={`w-full rounded-none py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-[filter] duration-150 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70 ${
                  direction === "long" ? "bg-[var(--long)] text-black" : "bg-[var(--short)] text-white"
                }`}
              >
                {initLoading ? "Creating account…" : showInlineDeposit ? "Close" : canOneClick ? "Create Account & Deposit" : needsAccount ? "Get Tokens to Trade" : "Deposit to Trade"}
              </button>
            );
          })()}
          {(initCtaError || initError) && <p className="mt-1 text-[10px] text-[var(--short)]">{initCtaError ?? initError}</p>}
          {showInlineDeposit && (
            <div className="mt-1.5" data-deposit-trigger>
              <DepositWithdrawCard slabAddress={slabAddress} />
            </div>
          )}
        </>
      ) : (
        <button
          onClick={() => {
            if (submitDisabled) return;
            const signedSize = direction === "short" ? -positionSize : positionSize;
            // Submit-time: re-fetch rather than trust the render-scoped
            // `livePriceE6` above — this is the one value in this component
            // where "read via getLivePriceSnapshot at submit" needs to mean
            // literally at this instant, not merely non-reactive.
            const freshPriceE6 = getLivePriceSnapshot(slabAddress).priceE6;
            let worstFillPriceE6 = 0n;
            try {
              worstFillPriceE6 = freshPriceE6 && freshPriceE6 > 0n ? computeLimitPriceE6({ markE6: freshPriceE6, size: signedSize }) : 0n;
            } catch {
              worstFillPriceE6 = 0n;
            }
            if (oneClickEnabled) {
              handleTrade(positionSize);
            } else {
              setConfirmSnapshot({
                positionSize,
                marginNative,
                estimatedLiqPrice: afterLiqPrice,
                tradingFee: fee,
                worstFillPriceE6,
              });
              setShowConfirmModal(true);
            }
          }}
          disabled={submitDisabled}
          className={`w-full rounded-none py-3 text-[12px] font-bold uppercase tracking-[0.12em] transition-[filter] duration-150 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100 ${
            direction === "long" ? "bg-[var(--long)] text-black" : "bg-[var(--short)] text-white"
          }`}
        >
          {tradePhase === "submitting" ? "Submitting…" : tradePhase === "confirming" ? "Confirmed!" : `${direction === "long" ? "Long" : "Short"} ${symbol} ${leverage}x`}
        </button>
      )}

      {humanError && (
        <div className="mt-2 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
          <p className="text-[10px] text-[var(--short)]">{humanError}</p>
        </div>
      )}
      {lastSig && (
        <p className="mt-2 text-[10px] text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
          Tx: <a href={explorerTxUrl(lastSig)} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">{lastSig.slice(0, 16)}...</a>
        </p>
      )}

      {/* Account row: balance / buying power / deposit link */}
      <div className="mt-3 flex items-center justify-between border-t border-[var(--border)]/30 pt-2.5 text-[10px]">
        <div>
          <div className="flex items-center gap-1 text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">
            Avail Bal
            <InfoIcon tooltip="Account balance minus margin already locked by an open position on this market." />
          </div>
          <div className="font-mono tabular-nums text-[var(--text)]">{formatTokenAmount(effectiveBalance, decimals)} {collateralSymbol}</div>
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-1 text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">
            Buying power
            <InfoIcon tooltip="Available balance x max leverage - the largest notional you could open right now." />
          </div>
          <div className="font-mono tabular-nums text-[var(--text)]">{formatTokenAmount(buyingPower, decimals)} {collateralSymbol}</div>
        </div>
        {connected && !needsAccount && !needsDeposit && (
          <div className="flex shrink-0 flex-col items-end gap-1">
            <button
              onClick={() => toggleInlineDeposit("deposit")}
              className="text-[10px] uppercase tracking-[0.12em] text-[var(--accent)] transition-colors duration-150 hover:brightness-110"
            >
              + Deposit
            </button>
            <button
              onClick={() => toggleInlineDeposit("withdraw")}
              className="text-[10px] uppercase tracking-[0.12em] text-[var(--long)] transition-colors duration-150 hover:brightness-110"
            >
              − Withdraw
            </button>
          </div>
        )}
      </div>
      {connected && !needsAccount && !needsDeposit && showInlineDeposit && (
        <div className="mt-1.5" data-deposit-trigger>
          <DepositWithdrawCard slabAddress={slabAddress} initialMode={inlineDepositMode} />
        </div>
      )}

      {getNetwork() === "mainnet" && (
        <div className="mt-3 border border-[var(--accent)]/30 bg-[var(--accent)]/[0.04] px-3 py-2 text-[10px] text-[var(--text)]">
          {maxLeverage}x max leverage enforced on-chain.
        </div>
      )}

      {showConfirmModal && confirmSnapshot && (
        <TradeConfirmationModal
          direction={direction}
          positionSize={confirmSnapshot.positionSize}
          margin={confirmSnapshot.marginNative}
          leverage={leverage}
          estimatedLiqPrice={confirmSnapshot.estimatedLiqPrice}
          tradingFee={confirmSnapshot.tradingFee}
          worstFillPriceE6={confirmSnapshot.worstFillPriceE6}
          accountEquity={userAccount ? capital : null}
          symbol={symbol}
          collateralSymbol={collateralSymbol}
          decimals={decimals}
          onConfirm={() => {
            const snapSize = confirmSnapshot.positionSize;
            setShowConfirmModal(false);
            setConfirmSnapshot(null);
            handleTrade(snapSize);
          }}
          onCancel={() => { setShowConfirmModal(false); setConfirmSnapshot(null); }}
        />
      )}
    </div>
  );
};

/** Memoized export — see the file-header comment above `OrderTicketInner`. */
export const OrderTicket = memo(OrderTicketInner);
