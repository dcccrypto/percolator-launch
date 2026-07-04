"use client";

/**
 * Phase 4 (trade-terminal rebuild): the new order ticket.
 *
 * Field order per the brief: Market/Limit tabs -> Long/Short segmented ->
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
 * "Limit" tab: Percolator's `TradeCpi` has no resting/pending order concept
 * — `trade()` always executes immediately; `limitPriceE6` is a worst-
 * acceptable-fill-price bound (slippage protection), already a supported,
 * proven parameter of `useTrade`. The Limit tab here means "market order,
 * reverts if the fill would be worse than this price" — not a CEX-style
 * resting limit order. Documented explicitly (see the tab's own copy) so
 * this isn't oversold as something the protocol doesn't do.
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
import { computeEstimatedEntryPrice, computeTradingFee } from "@/lib/trading";
import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";
import { InfoIcon } from "@/components/ui/Tooltip";
import { usePrivyLogin } from "@/hooks/usePrivySafe";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccountIdle } from "@/lib/mock-trade-data";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { formatTokenAmount, formatUsdPriceE6 } from "@/lib/format";
import { saveEntryPrice } from "@/lib/entry-price";
import { DepositWithdrawCard } from "@/components/trade/DepositWithdrawCard";
import { useInitUser } from "@/hooks/useInitUser";

const LEVERAGE_SNAP_POINTS = [1, 2, 5, 10, 20];
const SIZE_PRESETS = [25, 50, 75, 100];
const MAX_DISPLAY_LEVERAGE = 200;

function formatPerc(native: bigint, decimals = 6): string {
  const a = native < 0n ? -native : native;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const w = whole.toString();
  return frac ? `${w}.${frac}` : w;
}

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
    issues.push({ severity: "error", title: "Oracle unavailable", message: "Oracle not yet active — keeper has not cranked this market." });
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
      <span className="flex items-center gap-1 text-[var(--text-dim)] uppercase tracking-[0.08em]">
        {label}
        {tooltip && <InfoIcon tooltip={tooltip} />}
      </span>
      <span className="flex items-center gap-1 font-mono tabular-nums">
        {changed && <span className="text-[var(--text-dim)] line-through decoration-[var(--text-dim)]/50">{before}</span>}
        {changed && <span className="text-[var(--text-dim)]">→</span>}
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
  const { engine, params } = useEngineState();
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
  const vaultEmpty = engine !== null && vaultBalance === 0n && insuranceBalance === 0n && !isHyperp && !mockMode;

  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [limitPriceInput, setLimitPriceInput] = useState("");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [sizeUnit, setSizeUnit] = useState<"token" | "usd">("token");
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
  const effectiveBalance = userAccount ? capital : (walletAtaBalance ?? 0n);
  // Buying power: how large a position (in collateral notional) the user could
  // open at the current max leverage with their full available balance.
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
  }, [publicKey, mktConfig?.collateralMint, connection, mockMode]);

  // Reset form state on market switch (mirrors TradeForm's bug #1a12dab5 fix).
  useEffect(() => {
    setDirection("long");
    setSizeInput("");
    setMarginInput("");
    setLeverage(1);
    setLeverageText("1");
    setLimitPriceInput("");
    setOrderType("market");
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
      const marginStr = formatPerc(marginAmount, decimals);
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

  const marginNative = marginInput ? parsePercToNative(marginInput, decimals) : 0n;
  const notionalNative = marginNative * BigInt(leverage);
  const rawPositionSize = livePriceE6 && livePriceE6 > 0n ? (notionalNative * 1_000_000n) / livePriceE6 : 0n;
  const positionSize = rawPositionSize < 0n ? 0n : rawPositionSize;
  const exceedsBalance = marginNative > 0n && marginNative > effectiveBalance;

  // ── Receipt (before -> after) ──
  const oracleE6 = priceUsd ? BigInt(Math.round(priceUsd * 1e6)) : 0n;
  const hasOrder = marginNative > 0n && positionSize > 0n && !exceedsBalance;
  const estEntry = hasOrder ? computeEstimatedEntryPrice(oracleE6, tradingFeeBps, direction) : 0n;
  const fee = hasOrder ? computeTradingFee((positionSize * oracleE6) / 1_000_000n, tradingFeeBps) : 0n;
  const afterLiqPrice = hasOrder
    ? computePreTradeLiqPrice(oracleE6, marginNative, positionSize, maintenanceMarginBps, tradingFeeBps, direction)
    : 0n;
  const beforeLiqPrice = userAccount && userAccount.account.positionSize !== 0n && userAccount.account.entryPrice > 0n
    ? computeLiqPrice(userAccount.account.entryPrice, userAccount.account.capital, userAccount.account.positionSize, maintenanceMarginBps)
    : 0n;
  const beforeMargin = capital;
  const afterMargin = capital + marginNative;
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
    balanceLabel: `${formatPerc(effectiveBalance, decimals)} ${collateralSymbol}`,
  });
  const blockingIssue = validationIssues.find((i) => i.severity === "error") ?? null;

  const needsWallet = !connected;
  const needsAccount = connected && !userAccount;
  const needsDeposit = connected && userAccount && capital === 0n;

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
      // Limit tab: pass the user's explicit worst-price. Market tab: omit it
      // and let useTrade derive one from the live mark (its existing,
      // unchanged behaviour — see hooks/useTrade.ts).
      const explicitLimitE6 = orderType === "limit" && limitPriceInput
        ? BigInt(Math.round(parseFloat(limitPriceInput) * 1_000_000))
        : undefined;
      const sig = await withTransientRetry(
        async () => trade({ lpIdx, userIdx: userAccount!.idx, size, limitPriceE6: explicitLimitE6 }),
        { maxRetries: 2, delayMs: 3000 },
      );
      setTradePhase("confirming");
      setLastSig(sig ?? null);
      setMarginInput("");
      setSizeInput("");
      if (livePriceE6 && livePriceE6 > 0n && userAccount) {
        saveEntryPrice(slabAddress, userAccount.idx, livePriceE6, leverage);
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
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
      {/* Market / Limit tabs */}
      <div className="mb-3 flex gap-0.5 rounded-sm border border-[var(--border)] bg-[var(--bg-elevated)] p-0.5">
        {(["market", "limit"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setOrderType(t)}
            className={`flex-1 rounded-sm py-1 text-[10px] font-medium uppercase tracking-[0.12em] transition-colors duration-150 ${
              orderType === t ? "bg-[var(--accent)]/10 text-[var(--accent)]" : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {orderType === "limit" && (
        <div className="mb-3">
          <label className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">
            Limit price
            <InfoIcon tooltip="Percolator executes immediately — this sets the worst price your order is allowed to fill at (slippage bound), not a resting order that waits to be matched." />
          </label>
          <input
            type="text"
            value={limitPriceInput}
            onChange={(e) => setLimitPriceInput(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder={priceUsd ? priceUsd.toFixed(4) : "0.0000"}
            style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
            className="w-full rounded-none border border-[var(--border)]/40 bg-[var(--bg)] px-2 py-1.5 text-right text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:border-[var(--accent)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
          />
        </div>
      )}

      {/* Long / Short segmented */}
      <div className="mb-3 flex gap-1">
        <button
          onClick={() => setDirection("long")}
          className={`flex-1 rounded-none py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-all duration-150 ${
            direction === "long" ? "bg-green-500 border border-green-500 text-black" : "border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)]"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setDirection("short")}
          className={`flex-1 rounded-none py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-all duration-150 ${
            direction === "short" ? "bg-red-500 border border-red-500 text-white" : "border border-red-400/60 bg-red-500/[0.08] text-red-400 hover:bg-red-500/20"
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
            <InfoIcon tooltip="Position size in the toggled unit. Switch between token and USD — both stay in sync." />
          </label>
          <span className="text-[10px] text-[var(--text)]" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            Account Bal: {userAccount ? formatPerc(capital, decimals) : "0"} {collateralSymbol}
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
            className="w-16 shrink-0 rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text)]"
          >
            {sizeUnit === "token" ? symbol : "USD"}
          </button>
        </div>
        {exceedsBalance && (
          <p className="mt-1 text-[10px] text-[var(--short)]" style={{ fontFamily: "var(--font-mono)" }}>
            Exceeds balance ({formatPerc(effectiveBalance, decimals)} {collateralSymbol})
          </p>
        )}
      </div>
      <div className="mb-3 flex gap-1">
        {SIZE_PRESETS.map((pct) => (
          <button
            key={pct}
            onClick={() => setSizePercent(pct)}
            className="flex-1 rounded-none border border-[var(--border)]/30 py-1 text-[10px] font-medium text-[var(--text-secondary)] transition-colors duration-150 hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
          >
            {pct === 100 ? "Max" : `${pct}%`}
          </button>
        ))}
      </div>

      {/* Leverage slider + input */}
      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between">
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
        <input
          type="range"
          min={1}
          max={maxLeverage}
          step={1}
          value={leverage}
          onChange={(e) => updateLeverage(Number(e.target.value))}
          className="mb-2 h-1.5 w-full cursor-pointer appearance-none touch-none accent-[var(--accent)]"
        />
        <div className="flex flex-wrap gap-1">
          {availableLeverage.map((l) => (
            <button
              key={l}
              onClick={() => updateLeverage(l)}
              className={`flex-1 basis-0 min-w-[32px] rounded-none py-1.5 text-[9px] font-medium transition-colors duration-150 ${
                leverage === l ? "bg-[var(--accent)] text-white" : "border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/50"
              }`}
            >
              {l}x
            </button>
          ))}
        </div>
      </div>

      {/* Receipt — before -> after */}
      {hasOrder && (
        <div className="mb-3 rounded-none border border-[var(--border)]/40 bg-[var(--bg-elevated)]/40 px-2.5 py-2 divide-y divide-[var(--border)]/30">
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
            tooltip="Worst acceptable fill price sent on-chain — the trade reverts rather than fill worse than this."
          />
          <DiffRow
            label="Margin req."
            before={`${formatPerc(beforeMargin, decimals)} ${collateralSymbol}`}
            after={`${formatPerc(afterMargin, decimals)} ${collateralSymbol}`}
          />
        </div>
      )}

      {/* Single validation banner (highest-priority issue only) */}
      {blockingIssue && (
        <div className="mb-3 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">{blockingIssue.title}</p>
          <p className="mt-1 text-[9px] leading-relaxed text-[var(--text-secondary)]">{blockingIssue.message}</p>
        </div>
      )}

      {/* ONE big full-width submit */}
      {needsWallet ? (
        <button
          onClick={() => openWalletModal()}
          className="w-full rounded-none bg-[var(--accent)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-all duration-150 hover:brightness-110"
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
                className={`w-full rounded-none py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-black transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-70 ${
                  direction === "long" ? "bg-green-500 hover:bg-green-400" : "bg-red-500 hover:bg-red-400"
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
            setConfirmSnapshot({
              positionSize,
              marginNative,
              estimatedLiqPrice: afterLiqPrice,
              tradingFee: fee,
              worstFillPriceE6,
            });
            setShowConfirmModal(true);
          }}
          disabled={submitDisabled}
          className={`w-full rounded-none py-3 text-[12px] font-bold uppercase tracking-[0.12em] text-black transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
            direction === "long" ? "bg-green-500 hover:bg-green-400" : "bg-red-500 hover:bg-red-400 text-white"
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
          <div className="text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">Balance</div>
          <div className="font-mono tabular-nums text-[var(--text)]">{formatPerc(effectiveBalance, decimals)} {collateralSymbol}</div>
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-1 text-[9px] uppercase tracking-[0.1em] text-[var(--text-dim)]">
            Buying power
            <InfoIcon tooltip="Available balance x max leverage — the largest notional you could open right now." />
          </div>
          <div className="font-mono tabular-nums text-[var(--text)]">{formatPerc(buyingPower, decimals)} {collateralSymbol}</div>
        </div>
        {connected && !needsAccount && !needsDeposit && (
          <button
            onClick={() => setShowInlineDeposit((v) => !v)}
            className="shrink-0 text-[10px] uppercase tracking-[0.12em] text-[var(--accent)] transition-colors duration-150 hover:brightness-110"
          >
            + Deposit
          </button>
        )}
      </div>
      {connected && !needsAccount && !needsDeposit && showInlineDeposit && (
        <div className="mt-1.5" data-deposit-trigger>
          <DepositWithdrawCard slabAddress={slabAddress} />
        </div>
      )}

      <div className="mt-3 flex items-center gap-1.5">
        <InfoIcon tooltip={`This market is margined in ${symbol}, not USD. Selected leverage: ${leverage}x.`} />
        <span className="text-[9px] text-[var(--text)] uppercase tracking-[0.1em]">Coin-margined market</span>
      </div>

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
