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
import { useWalletBalanceRefreshKey } from "@/lib/wallet-balance-invalidation";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { computeNotionalNative } from "@/lib/notional";
import { availableLeverage as availableLeverageFor, nextLeverageInputState, clampSliderLeverage, LEVERAGE_STEP } from "@/lib/leverage-control";
import { useTrade, prewarmTradeSubmission } from "@/hooks/useTrade";
import { useFirstTrade } from "@/hooks/useFirstTrade";
import { FIRST_TRADE_COPY, FirstTradeDepositError, fundDepositAtoms, tradableMarginAtoms } from "@/lib/first-trade";
import { useMarketFillCap } from "@/hooks/useMarketFillCap";
import { UNLIMITED_CAPACITY } from "@/lib/marketCapacity";
import { isBlockedSlab } from "@/lib/blocklist";
import { humanizeError, isEngineLockError, withTransientRetry } from "@/lib/errorMessages";
import { useSingleMarketHealth } from "@/hooks/useMarketHealth";
import { safeExplainMarketTxError } from "@/lib/market-error";
import { PublicKey } from "@solana/web3.js";
import { diagnoseTradeRejection } from "@/lib/tradeRejectDiagnosis";
import { explorerTxUrl, getNetwork } from "@/lib/config";
import { useUserAccount, useUserAccountScanPending } from "@/hooks/useUserAccount";
import { OrderTicketClosePanel } from "@/components/trade/OrderTicketClosePanel";
import { computeLimitPriceE6 } from "@/lib/slippage";
import { bindConfirmedLimitPrice } from "@/lib/confirmedTrade";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { getLivePriceSnapshot } from "@/lib/priceStore/priceStore";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { useEngineFreshness } from "@/hooks/useEngineFreshness";
import { AccountKind, computeLiqPrice } from "@percolatorct/sdk";
import { computeEstimatedEntryPrice, computeTradingFee, computePositionInitialMargin, orderAgainstPosition, resolveEntryPrice } from "@/lib/trading";
import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";
import { InfoIcon } from "@/components/ui/Tooltip";
import { usePrivyLogin, usePrivyAvailable } from "@/hooks/usePrivySafe";
import { useWalletAdapterAvailable } from "@/hooks/useWalletAdapterAvailable";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccountIdle } from "@/lib/mock-trade-data";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { formatTokenAmount, formatUsdPriceE6, toE6, normalizeTokenDecimals } from "@/lib/format";
import { describeLiqPrice, type LiqPriceDisplay } from "@/lib/liq-price-display";
import { computeRiskLeverage, formatLeverageValue } from "@/lib/leverage-display";
import { saveEntryPrice, getEntryPrice, clearEntryPrice } from "@/lib/entry-price";
import { isSentinelValue } from "@/lib/health";
import { DepositWithdrawCard } from "@/components/trade/DepositWithdrawCard";
import { useInitUser } from "@/hooks/useInitUser";
import { AUTO_DEPOSIT_AMOUNT } from "@/hooks/useAutoDeposit";
import { depositAmountMessage } from "@/lib/deposit-guard";
import { useWalletNetworkGuard } from "@/hooks/useWalletNetworkGuard";
import { isOracleStaleBlocking } from "@/lib/oracle-stale-gate";
import { invalidatePortfolio } from "@/lib/portfolio-invalidation";
import { FEE_LEGS, legPercent, splitFeeAtoms } from "@/lib/fee-breakdown";
import { useMarketLimits } from "@/hooks/useMarketLimits";
import { closeLimitNotice, deriveTicketLimits, feeFitSizeQ, sizeQToInput, type TicketLimitsInput } from "@/lib/limits/ticket";
import { balanceMaxQ, deriveTicketState, maxInUnit, oneMaxQ, type TicketRow } from "@/lib/limits/ticket-state";
import { publishTicketRow } from "@/lib/limits/ticket-status-store";
import { fmtQ } from "@/lib/limits/format";
import { takeFillResult } from "@/lib/limits/fill-check";
import { defaultFeeCapMarginBps } from "@/lib/limits/fee-channel";
import { OrderTicketLimits, reasonCopy } from "@/components/limits/OrderTicketLimits";
import { StatusLine } from "@/components/ui/StatusLine";
import { FixPricingAction } from "@/components/trade/FixPricingAction";
import { resolveUserMessage, type UserMessage, type UserMessageAction } from "@/lib/limits/user-message";
import { TICKET_COPY } from "@/lib/limits/copy";
import { decodeMarketEngineView } from "@/lib/limits/decode";
import { isAdlReduceOnly } from "@/lib/limits/adl-reduce-only";

const SIZE_PRESETS = [25, 50, 75, 100];
const MAX_DISPLAY_LEVERAGE = 200;

function sanitizeDecimalInput(value: string): string {
  const cleaned = value.replace(/[^0-9.]/g, "");
  const dotIndex = cleaned.indexOf(".");
  if (dotIndex === -1) return cleaned;
  return cleaned.slice(0, dotIndex + 1) + cleaned.slice(dotIndex + 1).replace(/\./g, "");
}

// Truncate (never round) a number's decimal representation to `decimals`
// places. Rounding up can produce a native amount slightly larger than the
// user's actual balance (fractional float-overshoot), so derived input fields
// must truncate. Exponent-notation values fall back to toFixed (which never
// overshoots for the tiny magnitudes that render as e-notation). decimals=0
// returns the bare integer part — no trailing ".".
function truncateToDecimals(value: number, decimals: number): string {
  const str = value.toString();
  if (str.includes("e")) return value.toFixed(decimals);
  const dot = str.indexOf(".");
  if (dot === -1) return str;
  if (decimals === 0) return str.slice(0, dot);
  return str.slice(0, dot + 1 + decimals);
}



function parsePercToNative(input: string, decimalsRaw = 6): bigint {
  const decimals = normalizeTokenDecimals(decimalsRaw); // guard NaN/Infinity/negative before BigInt/padEnd
  const parts = input.split(".");
  if (parts.length > 2) return 0n;
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac);
}

/* UX WP-3: the old priority-ordered validation banner is lib/limits/ticket-state.ts now — the
 * ticket's ONE status slot + a state-labelled button (audit §3.3), unit-tested there. */

/** Collateral atoms at 2 dp (floored), "12.00" — the unit rule for USDC values (§4.2). */
function usd2(atoms: bigint, decimals: number): string {
  const cents = (atoms * 100n) / 10n ** BigInt(decimals);
  return `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function SummaryCell({ label, value, valueClass = "text-[var(--text)]", tooltip }: { label: string; value: string; valueClass?: string; tooltip?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-secondary)]">
        {label}
        {tooltip && <InfoIcon tooltip={tooltip} />}
      </span>
      <span className={`truncate font-mono ${valueClass}`}>{value}</span>
    </div>
  );
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
  // Only show the "before → after" transition when `before` is a REAL prior
  // value. A placeholder before ("—") means there's nothing to transition from
  // — the row is just previewing `after` — so the struck-through "— →" prefix
  // was pure noise and read as a conversion arrow. (Only rows with an actual
  // prior state, e.g. "Available to trade", pass a real `before`.)
  const beforeTrim = before.trim();
  const hasBefore = beforeTrim !== "" && beforeTrim !== "—" && beforeTrim !== "-";
  const changed = hasBefore && before !== after;
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
  // GH#2707: the portfolio scan has not answered yet, so `userAccount === null`
  // is "unknown", not "no account". Render "—"/loading and keep every
  // account-dependent action (fund-and-trade, deposit, onboarding) locked.
  const scanPending = useUserAccountScanPending();
  const accountPending = !mockMode && walletConnected && !userAccount && scanPending;
  const { trade, loading: tradeLoading, error } = useTrade(slabAddress);
  const { fundAndTrade, loading: fundLoading } = useFirstTrade(slabAddress);
  const loading = tradeLoading || fundLoading;
  /** UX WP-6: the deposit that rides with the first trade (editable; empty = the suggested one). */
  const [fundInput, setFundInput] = useState("");
  /** UX WP-6: the portfolio-id race happened; the second prompt is labelled. */
  const [raceNote, setRaceNote] = useState(false);
  // The market's per-trade size ceiling (immutable, resolved once).
  const fillCaps = useMarketFillCap(slabAddress);
  const { engine, params, insuranceBalance: liveInsuranceBalance, totalOI: liveTotalOI, hasData: engineHasData } = useEngineState();
  const { accounts, config: mktConfig, header, refresh: refreshSlab, programId: slabProgramId, raw: slabRaw } = useSlabState();
  // F-3 / R1 (not flag-gated — deployed engine behaviour): ADL reduce-only after a bankruptcy.
  const adlReduceOnly = useMemo(() => (slabRaw ? isAdlReduceOnly(decodeMarketEngineView(slabRaw)) : false), [slabRaw]);
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  // Non-reactive — see file-header comment. NOT `useLivePrice()`.
  const { priceUsd, priceE6: livePriceE6 } = getLivePriceSnapshot(slabAddress);
  const { level: oracleLevel, mode: oracleMode, ready: oracleReady } = useOracleFreshness();
  const oracleUnavailable = oracleLevel === "unavailable";
  // GH#2484: this was an inline ALLOWLIST of oracle modes, and it leaked twice —
  // first "keeper" (H7: a stale keeper-priced market never blocked trading,
  // firing for 0/5 live markets), then "pyth-pinned". The predicate now lives in
  // lib/oracle-stale-gate and blocks every recognised mode by default, so the
  // next mode added to the union cannot silently trade on a stale price.
  const oracleStale = !oracleUnavailable && isOracleStaleBlocking(oracleLevel, oracleMode, oracleReady);
  // H6: engine accrue-staleness — see useEngineFreshness's file header.
  const { engineStale } = useEngineFreshness();
  const openWalletModal = usePrivyLogin();
  const privyAvailable = usePrivyAvailable();
  const adapterAvailable = useWalletAdapterAvailable();
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
  // Open/Close mode (GH#2651). "Close" swaps the order form for
  // OrderTicketClosePanel, which reuses useClosePosition + ClosePositionModal.
  // That panel is a separate component so this ticket stays non-reactive to the
  // live price and does not mount the close hook while the trader is opening.
  const [ticketMode, setTicketMode] = useState<"open" | "close">("open");
  // USD is the default sizing unit — traders think in dollar notional first;
  // the chip next to the input switches to token units for those who don't.
  const [sizeUnit, setSizeUnit] = useState<"token" | "usd">("usd");
  const [sizeInput, setSizeInput] = useState("");
  const [marginInput, setMarginInput] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [leverageText, setLeverageText] = useState("1");
  // The unified snapping slider's native input is visually hidden (custom
  // thumb div instead) — track focus explicitly so the fake thumb can carry
  // a keyboard focus ring; opacity-0 would otherwise make the browser's own
  // focus-visible outline invisible too, silently regressing keyboard a11y.
  const [leverageFocused, setLeverageFocused] = useState(false);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [tradePhase, setTradePhase] = useState<"idle" | "submitting" | "waiting" | "confirming" | "error">("idle");
  const [humanError, setHumanError] = useState<string | null>(null);
  /** UX WP-1: a refusal the resolver mapped (simulation-gated: the wallet never opened). */
  const [refusal, setRefusal] = useState<UserMessage | null>(null);
  const [engineLockError, setEngineLockError] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmSnapshot, setConfirmSnapshot] = useState<{
    positionSize: bigint;
    marginNative: bigint;
    estimatedLiqPrice: bigint;
    estimatedLiqDisplay: LiqPriceDisplay;
    tradingFee: bigint;
    worstFillPriceE6: bigint;
    riskLeverage: number | null;
    depositAtoms: bigint;
  } | null>(null);
  const [showInlineDeposit, setShowInlineDeposit] = useState(false);
  // A faucet claim changes none of the wallet-balance effect's other deps.
  const walletBalanceKey = useWalletBalanceRefreshKey();
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
  // Starter-deposit amount for the one-click "Start Trading" CTA. The system
  // no longer chooses for the user: this is an EDITABLE field, prefilled with
  // the suggested min(500, wallet balance) once the balance resolves. A user
  // edit wins over the prefill from then on (touched ref).
  const [starterAmountInput, setStarterAmountInput] = useState("");
  const starterTouchedRef = useRef(false);
  const { networkWarning, reportTxError } = useWalletNetworkGuard();

  // Prefill the starter-deposit field once the wallet balance resolves —
  // plain decimal string (no thousands separators) so parsePercToNative can
  // read it back verbatim. Never stomps a user edit.
  useEffect(() => {
    if (starterTouchedRef.current) return;
    const bal = walletAtaBalance ?? 0n;
    if (bal <= 0n) return;
    const suggested = bal < AUTO_DEPOSIT_AMOUNT ? bal : AUTO_DEPOSIT_AMOUNT;
    setStarterAmountInput((Number(suggested) / 10 ** decimals).toString());
  }, [walletAtaBalance, decimals]);

  const lpEntry = useMemo(() => accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null, [accounts]);
  const lpIdx = lpEntry?.idx ?? 0;
  const hasValidLP = lpEntry !== null;
  const lpUnderfunded = hasValidLP && lpEntry!.account.capital === 0n;
  // P0b: on v17/v18 `accounts` is always [] (gotcha #2), so the check above is
  // dead there. The live v18 signal is the LP portfolio's capital from
  // /api/markets/health. Blocks OPENS only — a close reduces the LP's risk and
  // is not gated on this (OrderTicketClosePanel keeps the legacy value).
  const marketHealth = useSingleMarketHealth(slabAddress);
  // Limits UI (P1/P2/P3, flag-gated; returns state "off" and does no RPC when all flags are off).
  const marketLimits = useMarketLimits(slabAddress);
  /** WP-3 row 9: the size was just reduced to the max; the helper turns --warning for 4 s. */
  const [clampedToQ, setClampedToQ] = useState<bigint | null>(null);
  /** WP-3 result line (§3.3): full / partial / zero fill of the last order, in the status slot. */
  const [result, setResult] = useState<{ kind: "full" | "partial" | "zero"; body: string; sig: string | null; tryQ: bigint | null } | null>(null);
  /** WP-3: the wait loop passed ~30 s; "We'll keep trying" + Stop. */
  const [waitingLong, setWaitingLong] = useState(false);
  const waitAbortRef = useRef<AbortController | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  // P2 fee channel: slippage margin on the signed fee cap (default NEXT_PUBLIC_FEE_CAP_MARGIN_BPS or +2).
  const [feeMarginBps, setFeeMarginBps] = useState<number>(() => defaultFeeCapMarginBps());
  const lpDepleted = marketHealth?.lpDepleted === true;
  const lpIsVault = marketHealth?.lpIsVault === true;
  const marketResolved = marketHealth?.lockReasons.includes("resolved") === true;

  const { market: marketInfo } = useMarketInfo(slabAddress);
  const symbol = marketInfo?.symbol ?? collateralSymbol;
  // Base ticker for the size-unit toggle: the registry symbol carries a
  // "-PERP" suffix ("SOL-PERP"), which overflowed the w-16 toggle button into
  // "SOL-PE…". The size unit is the BASE asset, so strip the suffix; fall
  // back to a neutral "TOKEN" (never the collateral symbol — sizing is in
  // base units, and the collateral is sim-USDC on every playground market).
  const baseTicker = (marketInfo?.symbol ?? "").replace(/-PERP$/i, "").trim() || "TOKEN";
  const initialMarginBps = params?.initialMarginBps ?? 1000n;
  const maintenanceMarginBps = params?.maintenanceMarginBps ?? 500n;
  const tradingFeeBps = params?.tradingFeeBps ?? 30n;
  // HONEST cap: the engine allows notional / margin up to 10000/initial_margin_bps.
  // For the standard 1500-bps (15%) market that is 6.6667x, NOT 6 — the old
  // `Number(10000n / initialMarginBps)` truncated the remainder to 6, so the slider
  // silently robbed traders of the last ~0.67x the engine actually permits.
  // Floor to 2 decimals so a max-leverage order stays just UNDER the margin edge
  // (6.66x → margin ratio 15.02% ≥ 15%, never rejected), and displays as "6.7x".
  // The market list / wizard keep advertising the round floored value (6x); this
  // ticket exposes the true achievable ceiling.
  const maxLeverageFromOnChain = initialMarginBps > 0n
    ? Math.max(1, Math.floor((10000 / Number(initialMarginBps)) * 100) / 100)
    : 0;
  const supabaseLeverage = Number(marketInfo?.max_leverage) || 0;
  const rawMaxLeverage = maxLeverageFromOnChain > 0 ? maxLeverageFromOnChain : supabaseLeverage || 1;
  // P3 leverage step-down: a crowd-joining side gets a lower cap (probe = current crowd).
  const limitsStepDown = deriveTicketLimits({
    limits: marketLimits, direction, sizeQ: 0n, takerPosQ: 0n, takerOwner: null, leverage: 1, limitPriceE6: 0n,
  }).stepDown;
  const maxLeverage = Math.min(
    MAX_DISPLAY_LEVERAGE,
    rawMaxLeverage,
    limitsStepDown?.stepped ? Math.max(1, limitsStepDown.maxLeverage) : Number.POSITIVE_INFINITY,
  );

  const availableLeverage = useMemo(() => availableLeverageFor(maxLeverage), [maxLeverage]);
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
  // E: guard the sentinel BEFORE it feeds estimateEntryFromPnl's math — same
  // fix as PositionsDock/usePortfolio's identical call sites (an unguarded
  // u64::MAX-class account.pnl can poison the derived entry/liq/margin math
  // instead of being caught by estimateEntryFromPnl's own entry>0n clamp).
  const safeExistingPnl = userAccount && !isSentinelValue(userAccount.account.pnl)
    ? userAccount.account.pnl
    : 0n;
  // #2660: resolve through resolveEntryPrice (same numbers as the old inline
  // on-chain → cache → estimateEntryFromPnl chain) so the ticket also knows
  // the SOURCE. On "unknown" the value is the mark: fine for locked-margin
  // math, but it must not be shown as the entry (close panel) nor make the
  // "before" liq read as a statement about safety.
  const existingResolved = userAccount
    ? resolveEntryPrice(
        existingPositionSize,
        rawExistingEntryPrice > 0n ? rawExistingEntryPrice : cachedExistingEntryPrice,
        safeExistingPnl,
        livePriceE6 ?? 0n,
      )
    : null;
  const existingEntryPriceE6 = existingResolved?.entry ?? 0n;
  const existingEntryKnown = existingResolved != null && existingResolved.source !== "unknown" && existingEntryPriceE6 > 0n;
  const lockedMargin = computePositionInitialMargin(existingPositionSize, existingEntryPriceE6, initialMarginBps);
  const availableBalance = userAccount ? (capital > lockedMargin ? capital - lockedMargin : 0n) : 0n;
  const effectiveBalance = userAccount ? availableBalance : (walletAtaBalance ?? 0n);
  // What the ticket can OFFER: in-market available plus what the wallet can deposit in the same
  // approval (fund-and-trade), net of the deposit buffer and fee. `effectiveBalance` stays the
  // in-market figure that decides whether a deposit is bundled at all.
  // What "Available" SHOWS: the real money — free in-market USDC plus the wallet (2026-10-02 live
  // report: it showed the wallet / 1.1, so it never matched Solflare). Max / % use tradableBalance.
  const displayAvailable = mockMode
    ? effectiveBalance
    : (userAccount ? availableBalance : 0n) + (walletAtaBalance ?? 0n);
  const tradableBalance = mockMode
    ? effectiveBalance
    : tradableMarginAtoms({
        inMarketAvailable: userAccount ? availableBalance : 0n,
        walletAtoms: walletAtaBalance ?? 0n,
        leverage100: leverage * 100,
        feeBps: tradingFeeBps,
        decimals,
      });
  // Buying power: how large a position (in collateral notional) the user could
  // open at the current max leverage with their full AVAILABLE (not total)
  // balance — capital already locked by an open position can't back a
  // second one too.
  // Fractional-safe: maxLeverage can be 6.66, so scale by 100 rather than
  // Math.round (which would overshoot to 7x and make "Max" size a rejected order).
  const buyingPower = (tradableBalance * BigInt(Math.max(100, Math.round(maxLeverage * 100)))) / 100n;

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
  }, [publicKey, mktConfig?.collateralMint, connection, mockMode, capital, showInlineDeposit, walletBalanceKey]);

  // Reset form state on market switch (mirrors TradeForm's bug #1a12dab5 fix).
  useEffect(() => {
    setDirection("long");
    setSizeInput("");
    setMarginInput("");
    setLeverage(1);
    setLeverageText("1");
    setLastSig(null);
    setHumanError(null);
    setRefusal(null);
    setResult(null);
    setClampedToQ(null);
    setEngineLockError(null);
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
      // Truncate rather than round to prevent fractional float-overshoot
      // from generating a marginNative slightly larger than the user's actual balance.
      setMarginInput(truncateToDecimals(marginAmt, decimals));
    },
    [priceUsd, decimals],
  );

  /** Set the size WITHOUT clearing the status slot (the ticket's own clamp). */
  const applySize = useCallback(
    (val: string) => {
      const cleaned = sanitizeDecimalInput(val);
      setSizeInput(cleaned);
      recomputeFromSize(cleaned, sizeUnit, leverage);
    },
    [sizeUnit, leverage, recomputeFromSize],
  );
  /** A user edit: the last refusal / result / clamp note were about the old size, so clear them. */
  const handleSizeChange = useCallback(
    (val: string) => {
      setRefusal(null);
      setResult(null);
      setClampedToQ(null);
      applySize(val);
    },
    [applySize],
  );

  const toggleSizeUnit = useCallback(() => {
    setSizeUnit((prev) => {
      const next = prev === "token" ? "usd" : "token";
      const n = parseFloat(sizeInput);
      if (!isNaN(n) && priceUsd && priceUsd > 0) {
        const converted = prev === "token" ? n * priceUsd : n / priceUsd;
        const nextStr = truncateToDecimals(converted, next === "token" ? 6 : 2);
        setSizeInput(nextStr);
        recomputeFromSize(nextStr, next, leverage);
      }
      return next;
    });
  }, [sizeInput, priceUsd, leverage, recomputeFromSize]);

  const updateLeverage = useCallback(
    (newLev: number) => {
      setLeverage(newLev);
      setLeverageText(formatLeverageValue(newLev));
      if (sizeInput) recomputeFromSize(sizeInput, sizeUnit, newLev);
    },
    [sizeInput, sizeUnit, recomputeFromSize],
  );

  /**
   * GH#2628: the same update, WITHOUT rewriting the text box.
   *
   * updateLeverage reformats leverageText on every call, which made a decimal
   * impossible to type: "2" gave 2, then "." reformatted the field back to "2"
   * (parseFloat("2.") is 2, and the dot was erased), so the next keystroke
   * produced "25" — clamped to the market maximum. Typing 2.5 on a 10x market
   * silently selected 10x. The blur handler still normalises the text.
   */
  const updateLeverageFromText = useCallback(
    (newLev: number) => {
      setLeverage(newLev);
      if (sizeInput) recomputeFromSize(sizeInput, sizeUnit, newLev);
    },
    [sizeInput, sizeUnit, recomputeFromSize],
  );

  const setSizePercent = useCallback(
    (pct: number) => {
      if (tradableBalance <= 0n) return;
      let marginAmount = (tradableBalance * BigInt(pct)) / 100n;
      if (marginAmount === 0n && pct > 0) marginAmount = 1n;
      const marginStr = formatTokenAmount(marginAmount, decimals);
      setMarginInput(marginStr);
      const marginNum = Number(marginAmount) / Math.pow(10, decimals);
      const notionalUsd = marginNum * leverage;
      if (priceUsd && priceUsd > 0) {
        const nextSize = sizeUnit === "token" ? notionalUsd / priceUsd : notionalUsd;
        setSizeInput(truncateToDecimals(nextSize, sizeUnit === "token" ? 6 : 2));
      }
    },
    [tradableBalance, decimals, leverage, priceUsd, sizeUnit],
  );

  const marginNative = marginInput ? parsePercToNative(marginInput, decimals) : 0n;
  // GH#2616: shared with TradeConfirmationModal, which renders the confirmation
  // for this very quote. It was a second copy of this expression and did not get
  // the fractional-safe fix, so it threw on any fractional leverage.
  const notionalNative = computeNotionalNative(marginNative, leverage);
  const rawPositionSize = livePriceE6 && livePriceE6 > 0n ? (notionalNative * 1_000_000n) / livePriceE6 : 0n;
  const positionSize = rawPositionSize < 0n ? 0n : rawPositionSize;
  // GH#2953: the engine's initial margin is max(notional x IM bps, min_nonzero_im_req) (engine
  // v16.rs:23050 margin_requirement), so a NEW position needs at least the market's floor ($2 on
  // the wizard markets) however small it is: a $1 first trade deposited $1.11 and was refused
  // Custom(49) EngineInsufficientInitialMargin. Every margin check below (does the account hold
  // enough? how much to bundle?) uses this floored need, not the typed margin: an account holding
  // $1.50 placing a $1 first trade must bundle a top-up, not be refused 49.
  // The floor only applies with no open position, where vsPosition is always null.
  const imFloor = params?.minNonzeroImReq ?? 0n;
  const belowImFloor = existingPositionSize === 0n && marginNative > 0n && marginNative < imFloor;
  const marginNeed = belowImFloor ? imFloor : marginNative;
  // An order on the other side of the open position cuts it instead of adding exposure:
  // it releases margin, and only a flip that ends larger can need any.
  const vsPosition = userAccount
    ? orderAgainstPosition(marginNative, positionSize, direction, existingPositionSize, lockedMargin, capital)
    : null;
  const exceedsBalance = marginNative > 0n && (vsPosition ? vsPosition.shortBy > 0n : marginNeed > effectiveBalance);

  const needsWallet = !connected;
  const needsAccount = connected && !userAccount && !accountPending;
  const needsDeposit = connected && !!userAccount && capital === 0n;
  const walletHasTokens = (walletAtaBalance ?? 0n) > 0n;
  // UX WP-6 (§3.2): with sim-USDC in the wallet, "fund and trade" is ONE approval — no account
  // yet: [InitUser] + [Deposit, Trade] signed together; account short of margin: [Deposit, Trade].
  const fundingMode = !mockMode && connected && !accountPending && walletHasTokens && (needsAccount || needsDeposit || exceedsBalance);

  // ── Receipt (before -> after) ──
  const oracleE6 = priceUsd ? toE6(priceUsd) : 0n;
  const hasOrder = marginNative > 0n && positionSize > 0n && (!exceedsBalance || fundingMode);
  const estEntry = hasOrder ? computeEstimatedEntryPrice(oracleE6, tradingFeeBps, direction) : 0n;
  const fee = hasOrder ? computeTradingFee((positionSize * oracleE6) / 1_000_000n, tradingFeeBps) : 0n;
  // The deposit this order needs (margin + fee + 10%), editable; never more than the wallet holds.
  // GH#2953: the bundled deposit covers the IM floor (marginNeed, above).
  const marginShort = needsAccount
    ? marginNeed
    : vsPosition
      ? vsPosition.shortBy
      : marginNeed > availableBalance
        ? marginNeed - availableBalance
        : 0n;
  const fundNeededAtoms = fundingMode && hasOrder ? fundDepositAtoms(marginShort, fee, walletAtaBalance ?? 0n, decimals) : 0n;
  const fundMinAtoms = fundingMode && hasOrder ? marginShort + fee : 0n;
  const fundEnteredAtoms = fundInput ? parsePercToNative(fundInput, decimals) : 0n;
  const fundAtoms = fundEnteredAtoms > 0n ? fundEnteredAtoms : fundNeededAtoms;
  const fundOverWallet = fundingMode && fundAtoms > (walletAtaBalance ?? 0n);
  const fundTooSmall = fundingMode && hasOrder && fundAtoms < fundMinAtoms;
  const fundLabel = `${usd2(fundAtoms, decimals)} ${collateralSymbol}`;
  // The liquidation preview prices the account as it will be AFTER the bundled deposit.
  const capitalAfterFund = capital + (fundingMode && hasOrder ? fundAtoms : 0n);
  // Where that fee lands. Same split on every market (the RATE varies, the
  // division does not), so this is a constant string per fee amount. #2565.
  const feeDestinationTitle = (() => {
    if (fee <= 0n) return undefined;
    const parts = splitFeeAtoms(fee);
    const fmt = (v: bigint) => `${formatTokenAmount(v, decimals)} ${collateralSymbol}`;
    return FEE_LEGS.map((leg) => `${leg.label} ${legPercent(leg)}% (${fmt(parts[leg.id])})`).join(" · ");
  })();
  // M8 fix: two bugs in the receipt's liq-price row.
  // (1) beforeLiqPrice always read "—" because `userAccount.account
  //     .entryPrice` is always 0n on v17 (the on-chain field isn't
  //     populated) — same gap `existingEntryPriceE6` above already resolves
  //     (on-chain entry -> locally-cached entry -> pnl-implied entry), so use
  //     that instead of the raw always-zero field.
  // (2) afterLiqPrice always priced the order as a flat->fresh-position open
  //     (computePreTradeLiqPrice against just the NEW margin/size), silently
  //     ignoring any position already open on this market — a scale-in
  //     showed a liq price for the new slice alone, not the resulting
  //     COMBINED position. When there IS an existing position, blend it with
  //     this order the same way PositionsDock/PositionPanel already compute
  //     a standing position's liq price: full account capital + the
  //     resulting signed size, entry price weighted by the pre-trade cost
  //     basis for a same-direction add, unchanged for a partial reduce, or
  //     this trade's own fill price for a flip/fresh-open residual.
  const newSignedSize = direction === "short" ? -positionSize : positionSize;
  const combinedSignedSize = existingPositionSize + newSignedSize;
  const existingAbsSize = existingPositionSize < 0n ? -existingPositionSize : existingPositionSize;
  const sameDirection = existingPositionSize === 0n || (existingPositionSize > 0n) === (newSignedSize > 0n);
  const combinedEntryPriceE6 = sameDirection
    ? (existingAbsSize + positionSize > 0n
        ? (existingEntryPriceE6 * existingAbsSize + estEntry * positionSize) / (existingAbsSize + positionSize)
        : 0n)
    // Opposite direction: a partial reduce keeps the original cost basis; a
    // flip's residual position takes on this trade's fill price as its entry.
    : (positionSize < existingAbsSize ? existingEntryPriceE6 : estEntry);
  // Cross-margin: the full account capital backs the position — including a fresh
  // open (withdraw is blocked while any leg is open). Price both the fresh-open and
  // scale-in cases with the same capital-based computeLiqPrice as PositionsDock /
  // useLiqPrice: when there is no existing position, combinedSignedSize and
  // combinedEntryPriceE6 already reduce to this order's own signed size and
  // estimated entry, so one branch is correct for both. (Previously the fresh-open
  // case priced against only the order's margin, understating liq distance and
  // making the preview jump once the position opened on full capital.)
  const afterLiqPrice = hasOrder && combinedSignedSize !== 0n && combinedEntryPriceE6 > 0n
    ? computeLiqPrice(combinedEntryPriceE6, capitalAfterFund, combinedSignedSize, maintenanceMarginBps)
    : 0n;
  const beforeLiqPrice = userAccount && userAccount.account.positionSize !== 0n && existingEntryPriceE6 > 0n
    ? computeLiqPrice(existingEntryPriceE6, capital, userAccount.account.positionSize, maintenanceMarginBps)
    : 0n;
  // Cross-margin: where the account's collateral covers the resulting position
  // there is no liquidation price, and a "—" is not a risk number. The shared
  // display shows margin health instead (#2634 / #2558).
  const afterLiqDisplay = describeLiqPrice({
    liqPriceE6: afterLiqPrice,
    positionSize: hasOrder ? combinedSignedSize : 0n,
    capital: capitalAfterFund,
    markPriceE6: livePriceE6 ?? 0n,
    maintenanceMarginBps,
    // The combined entry inherits the existing one unless there is none, or
    // this order flips through it (the residual takes this fill's price).
    hasResolvedEntry:
      combinedEntryPriceE6 > 0n &&
      (existingPositionSize === 0n || existingEntryKnown || (!sameDirection && positionSize >= existingAbsSize)),
    formatPrice: formatUsdPriceE6,
    unknownText: "—",
  });
  const beforeLiqDisplay = describeLiqPrice({
    liqPriceE6: beforeLiqPrice,
    positionSize: existingPositionSize,
    capital,
    markPriceE6: livePriceE6 ?? 0n,
    maintenanceMarginBps,
    hasResolvedEntry: existingEntryKnown,
    formatPrice: formatUsdPriceE6,
    unknownText: "—",
  });
  // BUG 9 fix + copy clarity: opening a position RESERVES margin from
  // existing capital — it is not a deposit. The old receipt row was labeled
  // "Margin req." but actually showed capital -> capital-minus-margin (a
  // balance readout), so the actual requirement never appeared as a number
  // and the label lied about the row. The receipt now shows BOTH, on the
  // same "available" basis as the account strip above (capital minus margin
  // already locked by an open position) so the two readouts can't disagree:
  //   Margin            — what THIS order reserves (the requirement)
  //   Available to trade — before -> after reserving it
  const beforeAvailable = availableBalance;
  const afterAvailable = vsPosition
    ? vsPosition.afterAvailable
    : beforeAvailable > marginNative
      ? beforeAvailable - marginNative
      : 0n;
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

  // ── Limits (P1/P2/P3) — every decision is lib/limits/ticket.ts ──
  const limitsInput: TicketLimitsInput = {
    limits: marketLimits,
    direction,
    sizeQ: positionSize,
    takerPosQ: existingPositionSize,
    takerOwner: publicKey ? publicKey.toBytes() : null,
    leverage,
    limitPriceE6: slippageBoundE6,
    markE6: livePriceE6 ?? undefined,
    feeMarginBps,
  };
  const ticketLimits = deriveTicketLimits(limitsInput);
  // P1 99165722 (F-7): a close that GROWS a halted / capped LP is refused or clipped too.
  const limitsCloseNotice = closeLimitNotice(existingPositionSize, ticketLimits.sideLimits);

  // ── ONE max per side (UX WP-3, TR-2) ──
  // The tightest of every cap the market enforces: P1 maxTradeSizePerSide, the matcher's
  // per-trade fill cap (over it the trade reverts whole) and the LP's net-inventory room on the
  // side (legacy "capacity left"). They used to be three rows that disagreed; now one figure.
  // maxFillAbs at the i128::MAX sentinel (or 0) means "no practical per-trade cap".
  const fillCapUnlimited =
    fillCaps != null && (fillCaps.maxFillAbs <= 0n || fillCaps.maxFillAbs >= UNLIMITED_CAPACITY);
  const fillCapQ = !mockMode && fillCaps != null && !fillCapUnlimited ? fillCaps.maxFillAbs : null;
  const legacySideCapQ = (side: "long" | "short"): bigint | null =>
    // Matcher-inventory drift: min(counter, real LP position) until the upgrade is live, then the
    // real position (useMarketFillCap.sideRoomQ / lib/limits/lp-inventory-room.ts).
    !mockMode && fillCaps != null && typeof fillCaps.sideRoomQ === "function" ? fillCaps.sideRoomQ(side) : null;
  const marketMaxQFor = (side: "long" | "short") =>
    oneMaxQ([ticketLimits.sideLimits?.[side]?.maxQ, fillCapQ, legacySideCapQ(side)]);
  const marketMaxQ = marketMaxQFor(direction);
  const sidePaused = {
    long: ticketLimits.halted.long || legacySideCapQ("long") === 0n,
    short: ticketLimits.halted.short || legacySideCapQ("short") === 0n,
  };
  // The Max the trader sees (and the Max chip fills): the market's cap or what the balance can
  // margin at this leverage, whichever is smaller, in the input's unit.
  const displayMaxQ = oneMaxQ([marketMaxQ, balanceMaxQ(tradableBalance, leverage, livePriceE6)]);

  // Row 9 (AUTO): over the max, the size is reduced to it and the helper says so for 4 s.
  const clampTarget = marketMaxQ !== null && marketMaxQ > 0n && positionSize > marketMaxQ ? marketMaxQ : null;
  useEffect(() => {
    if (clampTarget === null || !livePriceE6 || livePriceE6 <= 0n) return;
    applySize(sizeQToInput(clampTarget, sizeUnit, livePriceE6));
    setClampedToQ(clampTarget);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only when a new clamp is required
  }, [clampTarget]);
  useEffect(() => {
    if (clampedToQ === null) return;
    const t = setTimeout(() => setClampedToQ(null), 4000);
    return () => clearTimeout(t);
  }, [clampedToQ]);

  // Row 8 (AUTO): a busy side's step-down lowers the slider max; a chosen leverage above the
  // cap for this size is set to it.
  const levCapForSize = Math.min(maxLeverage, ticketLimits.stepDown?.maxLeverageAtSize ?? Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (levCapForSize >= 1 && leverage > levCapForSize) updateLeverage(Math.floor(levCapForSize * 100) / 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the cap drops below the choice
  }, [levCapForSize, leverage]);

  const feeOverMax = ticketLimits.issues.some((x) => x.kind === "fee-over-max");
  const feeFitQ = feeOverMax ? feeFitSizeQ(limitsInput) : null;
  const shortfall = vsPosition ? vsPosition.shortBy : marginNeed > effectiveBalance ? marginNeed - effectiveBalance : 0n;

  // ── The state machine (audit §3.3): one status slot, one state-labelled button ──
  const ticketState = deriveTicketState({
    direction,
    baseSymbol: baseTicker,
    leverageLabel: formatLeverageValue(leverage),
    marketRetired: !mockMode && isBlockedSlab(slabAddress),
    marketResolved,
    marketPaused: !!header?.paused,
    adlReduceOnly,
    engineStale,
    waitingForPrice: !mockMode && (oracleUnavailable || oracleStale || priceUsd == null),
    sidePaused,
    openingPaused: !mockMode && (vaultEmpty || lpDepleted || lpUnderfunded || riskGateActive),
    lpDepleted: !mockMode && lpDepleted,
    lpIsVault,
    sameOwner: ticketLimits.sameOwner,
    exceedsBalance,
    shortfallLabel: fundingMode ? fundLabel : `${formatTokenAmount(shortfall, decimals)} ${collateralSymbol}`,
    feeOverMax,
    feeSuggested: feeFitQ !== null ? `${fmtQ(feeFitQ)} ${baseTicker}` : null,
  });
  // Row 5 (LIMIT): the selected side is paused and the other is open => select the open one.
  useEffect(() => {
    if (ticketState.autoSelect) setDirection(ticketState.autoSelect);
  }, [ticketState.autoSelect]);
  // Row 2: ADL reduce-only moves the ticket to Close when it starts (the Open tab says why).
  const adlWasOn = useRef(false);
  useEffect(() => {
    if (adlReduceOnly && !adlWasOn.current) setTicketMode("close");
    adlWasOn.current = adlReduceOnly;
  }, [adlReduceOnly]);
  // The mobile sheet's collapsed bar names a blocked ticket ("Trade · Close-only").
  useEffect(() => {
    publishTicketRow(slabAddress, ticketState.row === "ok" || ticketState.row === "exceeds-balance" ? null : ticketState.row);
  }, [slabAddress, ticketState.row]);
  useEffect(() => () => publishTicketRow(slabAddress, null), [slabAddress]);
  // A step-down the ticket could not absorb (a cap below 1×) still blocks.
  const limitsBlocking = ticketLimits.issues.some((x) => x.kind === "step-down" && x.severity === "error") && levCapForSize < 1;

  // With no wallet, or no account / an unfunded one AND nothing in the wallet, every control
  // below can only compose an order that cannot be submitted — the CTA at the bottom (Connect /
  // Get Tokens) is the only real action. With tokens in the wallet the ticket is fully usable:
  // the button funds and trades in one approval (UX WP-6).
  const ticketLocked = needsWallet || accountPending || ((needsAccount || needsDeposit) && !walletHasTokens);

  async function handleTrade(
    snapshotSize?: bigint,
    snapshotLimitPriceE6?: bigint,
  ) {
    const effectiveSize = snapshotSize ?? positionSize;
    if (!marginInput || effectiveSize <= 0n) return;
    if (accountPending) return;
    if ((!userAccount || exceedsBalance) && !fundingMode) return;

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
    setRefusal(null);
    setResult(null);
    setEngineLockError(null);
    setWaitingLong(false);
    setRaceNote(false);
    const waitAbort = new AbortController();
    waitAbortRef.current = waitAbort;
    const submitPriceE6 = getLivePriceSnapshot(slabAddress).priceE6 ?? livePriceE6 ?? 0n;
    setTradePhase("submitting");
    try {
      const size = direction === "short" ? -effectiveSize : effectiveSize;
      // Confirmed submissions carry the exact worst-fill bound reviewed
      // in the modal. Other callers retain useTrade's live-mark fallback.
      const sig = fundingMode
        ? (
            await fundAndTrade({
              size,
              depositAtoms: fundAtoms,
              limitPriceE6:
                snapshotLimitPriceE6 ??
                computeLimitPriceE6({ markE6: getLivePriceSnapshot(slabAddress).priceE6 ?? livePriceE6 ?? 0n, size }),
              ...(ticketLimits.fee?.channel.enabled ? { feeBps: ticketLimits.fee.signedFeeBps } : {}),
              amountLabel: fundLabel,
              onRace: () => setRaceNote(true),
            })
          ).signature
        : await withTransientRetry(
        async () =>
          trade(
            bindConfirmedLimitPrice(
              {
                lpIdx,
                userIdx: userAccount?.idx ?? 0,
                size,
                // P2 fee channel: sign base + the quote's fee (the taker's consent cap); only when
                // the protocol enabled the channel for this asset — else the base fee as before.
                ...(ticketLimits.fee?.channel.enabled ? { feeBps: ticketLimits.fee.signedFeeBps } : {}),
                // UX WP-2: the app waits for the market (no prompt) instead of failing.
                onWaiting: (w: boolean) => setTradePhase(w ? "waiting" : "submitting"),
                // UX WP-3: it keeps waiting past ~30 s ("We'll keep trying") until Stop.
                keepWaiting: true,
                onWaitingLong: () => setWaitingLong(true),
                abortSignal: waitAbort.signal,
              },
              snapshotLimitPriceE6,
            ),
          ),
        { maxRetries: 2, delayMs: 3000 },
      );
      setWaitingLong(false);
      // P1: a confirmed TradeCpi can be a partial or ZERO fill (lib/limits/fill-check.ts).
      const limitsFillResult = takeFillResult(sig);
      setClampedToQ(null);
      const sideWord = direction === "long" ? "long" : "short";
      if (limitsFillResult?.kind === "zero") {
        // Never "Confirmed!" for a no-op: nothing filled, nothing to save. Offer a smaller size.
        const room = marketMaxQFor(direction);
        const tryQ = room !== null && room > 0n && room < effectiveSize ? room : effectiveSize / 2n;
        setResult({ kind: "zero", body: TICKET_COPY.result.zero, sig: sig ?? null, tryQ: tryQ > 0n ? tryQ : null });
        setLastSig(sig ?? null);
        setTradePhase("idle");
        refreshSlab();
        return;
      }
      setResult(
        limitsFillResult?.kind === "partial"
          ? { kind: "partial", body: TICKET_COPY.result.partial(fmtQ(limitsFillResult.filledQ ?? 0n), fmtQ(effectiveSize), baseTicker), sig: sig ?? null, tryQ: null }
          : {
              kind: "full",
              body: TICKET_COPY.result.full(fmtQ(effectiveSize), baseTicker, sideWord, formatUsdPriceE6(submitPriceE6)),
              sig: sig ?? null,
              tryQ: null,
            },
      );
      setTradePhase("confirming");
      setLastSig(sig ?? null);
      setEngineLockError(null);
      setMarginInput("");
      setSizeInput("");
      // A first fund-and-trade runs with no account in this closure (fundingMode allows it), and the
      // portfolio it just created is a v17 one: idx 0, like every v17 account (lib/userAccountScan.ts).
      const entryIdx = userAccount?.idx ?? (fundingMode ? 0 : null);
      if (livePriceE6 && livePriceE6 > 0n && entryIdx !== null) {
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
          saveEntryPrice(slabAddress, entryIdx, livePriceE6, leverage, wallet);
        } else {
          clearEntryPrice(slabAddress, entryIdx, wallet);
        }
      }
      // The site-wide PositionsBar reads usePortfolio, which refreshes its
      // position list on a 30s interval and learns nothing from refreshSlab()
      // — that only updates this page's own dock via the slab-bytes scan. So
      // a new position sat missing from the header for up to half a minute.
      // Closing already had this (`onClosed={portfolio.refresh}`); opening did
      // not. Fired immediately rather than inside the 1500ms timeout below:
      // the notification carries its own reconciliation burst, so there is
      // nothing to wait for. See lib/portfolio-invalidation.ts.
      invalidatePortfolio();
      setTimeout(() => {
        refreshSlab();
        setTradePhase("idle");
      }, 1500);
    } catch (e) {
      setWaitingLong(false);
      setRaceNote(false);
      if (e instanceof FirstTradeDepositError) {
        // §3.2 item 5: the account exists but the deposit didn't land — say so, offer the deposit.
        setRefusal({
          kind: "first-trade-deposit",
          variant: "error",
          title: "Deposit didn't go through",
          body: e.message,
          action: { id: "get-funds", label: `Deposit ${e.amountLabel}` },
          details: { code: null, name: null, programId: null, logs: [], raw: String((e as Error & { cause?: unknown }).cause ?? e.message) },
        });
        setTradePhase("idle");
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[OrderTicket] raw error:", msg);
      // PERC-onboarding-5: advisory-only wrong-network-wallet check on the
      // raw (pre-humanization) message — see useWalletNetworkGuard's header.
      reportTxError(msg);
      // TX1: Custom(9) from THIS call site is always a trade() CPI, so use the
      // trade-context text (not the generic "invalid instruction" one, which is
      // still correct for deposit/withdraw/NFT/market-creation call sites).
      // Custom(9) is NOT always slippage — see the #2643 refinement below.
      // P0b: refine 19/21/49 with live market health (LP depleted / resolved /
      // bankruptcy / repairable) — lib/market-error.ts. Wallet lock and program
      // Unauthorized(8) are never refined into "locked".
      // UX WP-1: one resolver. A mapped refusal (usually caught by sendTx's pre-sign
      // simulation, so the wallet never opened) renders as ONE StatusLine with its next
      // step ("Use {max}"); only unmapped failures fall back to the legacy explanations.
      const sideMaxQ = ticketLimits.sideLimits?.[direction]?.maxQ ?? null;
      const um = resolveUserMessage(e, {
        surface: "trade",
        side: direction,
        symbol: marketInfo?.symbol ?? undefined,
        maxNow: sideMaxQ !== null && sideMaxQ > 0n && sideMaxQ < UNLIMITED_CAPACITY ? fmtQ(sideMaxQ) : undefined,
        health: { lpDepleted, lpIsVault, adlReduceOnly, resolved: marketResolved },
        // GH#2953: fund-and-trade does not wait and resend; never promise "goes through automatically".
        oneShot: fundingMode,
        // GH#2959: a 49 on a new position below the market's floor is the floor, not the size.
        ...(belowImFloor ? { imFloorLabel: `$${usd2(imFloor, decimals).replace(/\.00$/, "")}` } : {}),
      });
      if (um.quiet) {
        // GH#2959: a first fund-and-trade the user turned down in the wallet reset the ticket
        // with no word (some wallets showed their own warning, so it read as "nothing happened").
        // Say it, calmly. Other cancels (and Stop) stay quiet.
        if (fundingMode && um.kind === "cancelled") {
          setRefusal({ ...um, quiet: false, title: "Cancelled", body: FIRST_TRADE_COPY.cancelled });
        }
        setTradePhase("idle");
        return;
      }
      if (um.kind !== "unmapped") {
        setRefusal(um);
        setTradePhase("error");
        setTimeout(() => setTradePhase("idle"), 1200);
        return;
      }
      const friendlyMsg = safeExplainMarketTxError(msg, "open", marketHealth) ?? humanizeError(msg, "trade");
    if (isEngineLockError(msg)) {
      setEngineLockError(friendlyMsg);
    }
    setHumanError(friendlyMsg)
      // #2643: Custom(9) is ambiguous (slippage vs an unusable market). Show the
      // generic text immediately, then refine it from pre-trade state (matcher
      // context / market completeness) if that proves the real cause. No-op for
      // every other error code.
      if (slabProgramId) {
        void diagnoseTradeRejection(msg, connection, slabProgramId, new PublicKey(slabAddress))
          .then((refined) => { if (refined) setHumanError(refined); })
          .catch(() => { /* keep the generic message */ });
      }
      // Brief "Failed" flash on the submit button itself (matches the
      // "Confirmed!" success flash below) before reverting to idle — the
      // detailed reason stays in the humanError banner underneath.
      setTradePhase("error");
      setTimeout(() => setTradePhase("idle"), 1200);
    }
  }

  const submitDisabled =
    accountPending ||
    tradePhase !== "idle" ||
    loading ||
    ticketState.blocks ||
    limitsBlocking ||
    fundTooSmall ||
    !marginInput ||
    positionSize <= 0n ||
    (exceedsBalance && !fundingMode && ticketState.row !== "exceeds-balance");

  // ── The ONE status slot (audit §3.3 / §4.1) ──────────────────────────────
  // First match wins: a market state that blocks, a long wait, the last refusal / failure,
  // the last result line, then an advisory wallet-network note. Empty = no DOM.
  const onSlotAction = (a: UserMessageAction) => {
    if (a.id === "stop") {
      waitAbortRef.current?.abort();
      return;
    }
    if (a.id === "get-funds") {
      toggleInlineDeposit("deposit");
      return;
    }
    const q = a.id === "try-size" ? result?.tryQ ?? null : a.id === "use-max" ? ticketLimits.sideLimits?.[direction]?.maxQ ?? null : null;
    if (q && q > 0n && livePriceE6 && livePriceE6 > 0n) handleSizeChange(sizeQToInput(q, sizeUnit, livePriceE6));
  };
  const LEGACY_TESTID: Partial<Record<TicketRow, string>> = {
    "close-only": "limits-adl-reduce-only",
    "side-paused": "limits-halt-notice",
    "same-owner": "limits-same-owner-notice",
    "fee-over-max": "limits-quote-fee-over-max",
  };
  const statusSlot = (() => {
    if (ticketState.status) {
      const legacy = LEGACY_TESTID[ticketState.row];
      const line = <StatusLine message={ticketState.status} legacyTestId={legacy} />;
      return legacy ? <div data-testid={legacy} data-side={direction}>{line}</div> : line;
    }
    if (tradePhase === "waiting" && waitingLong) {
      return (
        <StatusLine
          message={{ kind: "waiting-long", variant: "wait", title: TICKET_COPY.waitingLong.title, body: TICKET_COPY.waitingLong.body, action: { id: "stop", label: TICKET_COPY.waitingLong.stop } }}
          onAction={onSlotAction}
        />
      );
    }
    if (raceNote && tradePhase === "submitting") {
      return <StatusLine message={{ kind: "first-trade-race", variant: "info", title: "One more approval", body: FIRST_TRADE_COPY.race }} />;
    }
    const why = networkWarning ?? undefined;
    if (refusal) {
      return (
        <div data-testid="trade-error" data-kind={refusal.kind}>
          <StatusLine message={{ ...refusal, why: refusal.why ?? why }} legacyTestId="trade-error" onAction={onSlotAction} />
        </div>
      );
    }
    if (engineLockError) {
      return (
        <div data-testid="trade-error" data-kind="engine-lock">
          <StatusLine message={{ kind: "engine-lock", variant: "wait", title: "Market busy", body: `${engineLockError} This usually clears within a minute.`, why }} legacyTestId="trade-error" />
        </div>
      );
    }
    if (humanError) {
      return (
        <div data-testid="trade-error" data-kind="trade">
          <StatusLine message={{ kind: "trade-error", variant: "error", title: "Order not placed", body: humanError, why }} legacyTestId="trade-error" />
        </div>
      );
    }
    if (result) {
      const kind = result.kind === "zero" ? "zero-fill" : result.kind === "partial" ? "partial-fill" : "filled";
      const title = result.kind === "zero" ? "Not filled" : result.kind === "partial" ? "Partly filled" : "Order filled";
      const line = (
        <StatusLine
          message={{
            kind,
            variant: "info",
            title,
            body: result.body,
            ...(result.kind === "zero" && result.tryQ ? { action: { id: "try-size" as const, label: TICKET_COPY.result.tryChip(`${fmtQ(result.tryQ)} ${baseTicker}`) } } : {}),
          }}
          onAction={onSlotAction}
          txUrl={result.sig ? explorerTxUrl(result.sig) : undefined}
        />
      );
      return result.kind === "full" ? line : <div data-testid="limits-fill-result" data-kind={result.kind}>{line}</div>;
    }
    if (networkWarning) {
      return <StatusLine message={{ kind: "wallet-network", variant: "info", title: "Check your wallet's network", body: networkWarning }} />;
    }
    return null;
  })();

  // ── Close mode ──────────────────────────────────────────────────────────
  const handleClosed = (percent: number) => {
    // Refresh this ticket's own position readout past the RPC cache window;
    // useClosePosition already fired invalidatePortfolio() for the header bar.
    setTimeout(() => refreshSlab(), 1200);
  };

  // Open/Close segmented toggle — above Long/Short, shared by both modes.
  const openCloseToggle = (
    <div className="mb-3 flex gap-1" role="tablist" aria-label="Open or close position">
      {(["open", "close"] as const).map((m) => (
        <button
          key={m}
          role="tab"
          aria-selected={ticketMode === m}
          onClick={() => setTicketMode(m)}
          data-testid="trade-mode-tab"
          data-mode={m}
          className={`flex-1 rounded-none border py-2 text-[11px] font-bold uppercase tracking-[0.1em] transition-colors duration-150 ${
            ticketMode === m
              ? "border-[var(--accent)] bg-[var(--accent)]/[0.08] text-[var(--accent)]"
              : "border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text)]"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );

  // ── Close mode — swap the order form for a compact close panel ───────────
  if (ticketMode === "close") {
    return (
      <div className="relative p-3.5" data-testid="order-ticket" data-ticket-mode="close">
        {openCloseToggle}
        {(() => {
          // UX WP-3 / §3.4: one close note, priority ADL route > halted > capped.
          const note = adlReduceOnly
            ? { id: "limits-adl-close-route", kind: "close-adl", variant: "info" as const, title: TICKET_COPY.closeOnly.title, body: TICKET_COPY.close.adl }
            : limitsCloseNotice?.kind === "halted"
              ? { id: "limits-close-halt-notice", kind: "close-paused", variant: "paused" as const, title: "Closing paused", body: TICKET_COPY.close.halted }
              : limitsCloseNotice?.kind === "capped"
                ? { id: "limits-close-cap-notice", kind: "close-capped", variant: "info" as const, title: "Partial close only", body: TICKET_COPY.close.capped(fmtQ(limitsCloseNotice.maxQ), baseTicker) }
                : null;
          return note ? (
            <div className="mb-3" data-testid={note.id}>
              <StatusLine message={note} legacyTestId={note.id} />
            </div>
          ) : null;
        })()}
        <OrderTicketClosePanel
          slabAddress={slabAddress}
          positionSize={existingPositionSize}
          accountPending={accountPending}
          entryPriceE6={existingEntryKnown ? existingEntryPriceE6 : 0n}
          capital={capital}
          symbol={symbol}
          collateralSymbol={collateralSymbol}
          decimals={decimals}
          tradingFeeBps={params?.tradingFeeBps}
          maxFillAbs={fillCaps?.maxFillAbs ?? null}
          lpUnderfunded={lpUnderfunded}
          engineStale={engineStale}
          oracleBlocked={!mockMode && (oracleUnavailable || oracleStale)}
          onClosed={handleClosed}
        />
      </div>
    );
  }

  // Row 8 inline note (only while a step-down is active): both sides' caps, under the slider.
  const stepDownNote =
    ticketLimits.stepDown?.stepped
      ? TICKET_COPY.stepDownInline(
          formatLeverageValue(ticketLimits.stepDown.maxLeverage),
          direction === "long" ? "longs" : "shorts",
          formatLeverageValue(ticketLimits.stepDown.otherSideMaxLeverage ?? ticketLimits.stepDown.baseMaxLeverage),
          direction === "long" ? "Shorts" : "Longs",
        )
      : null;
  // One Max per side (§4.2): in the input's unit, tap = fill. Hidden while the ticket can't open.
  const showMax = displayMaxQ !== null && displayMaxQ > 0n && !!livePriceE6 && livePriceE6 > 0n && !ticketState.blocks;
  const maxLabel = showMax ? maxInUnit(displayMaxQ!, sizeUnit, livePriceE6!, baseTicker) : null;
  const fillFraction = (pct: number) => {
    if (displayMaxQ !== null && displayMaxQ > 0n && livePriceE6 && livePriceE6 > 0n) {
      handleSizeChange(sizeQToInput((displayMaxQ * BigInt(pct)) / 100n, sizeUnit, livePriceE6));
      return;
    }
    setSizePercent(pct);
  };
  const clampReason = ticketLimits.sideLimits ? reasonCopy(ticketLimits, marketLimits, direction) : "";

  return (
    <div className="relative p-3.5" data-testid="order-ticket" data-ticket-row={ticketState.row}>
      {openCloseToggle}
      {statusSlot && <div className="mb-3" data-testid="ticket-status-slot">{statusSlot}</div>}
      {/* Creator-only, self-hiding: the LP owner can drop the matcher's skew (lib/fix-pricing.ts). */}
      {ticketLimits.sameOwnerCloseOnly && !mockMode && (
        <div className="mb-3" data-testid="fix-pricing-slot"><FixPricingAction slabAddress={slabAddress} /></div>
      )}

      {/* Locked shell — a disabled fieldset natively disables every input and
          button inside (including keyboard focus), and the opacity drop makes
          the "not yet" state legible at a glance. min-w-0 counters fieldset's
          default min-inline-size: min-content, which would otherwise stop the
          ticket from shrinking in narrow layouts. */}
      <fieldset
        disabled={ticketLocked}
        aria-disabled={ticketLocked}
        className={`min-w-0 transition-opacity duration-150 ${ticketLocked ? "pointer-events-none select-none opacity-40" : ""}`}
      >

      {/* Long / Short segmented. A paused side (no room for new exposure) carries a "Paused"
          sublabel, 40% opacity and can't be selected; the ticket selects the open side. */}
      <div className="mb-3 flex gap-1">
        <button
          onClick={() => setDirection("long")}
          data-testid="trade-side-long"
          data-side="long"
          data-limits-halted={sidePaused.long ? "true" : undefined}
          disabled={sidePaused.long}
          aria-disabled={sidePaused.long}
          aria-pressed={direction === "long"}
          className={`flex flex-1 flex-col items-center rounded-none border py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
            direction === "long"
              ? "border-[var(--long)] bg-[var(--long)] text-black"
              : "border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--long)]/40 hover:text-[var(--text)]"
          }`}
        >
          Long
          {sidePaused.long && (
            <span data-testid="trade-side-paused" className="text-[10px] font-medium normal-case tracking-normal">
              {TICKET_COPY.sidePausedSublabel}
            </span>
          )}
        </button>
        <button
          onClick={() => setDirection("short")}
          data-testid="trade-side-short"
          data-side="short"
          data-limits-halted={sidePaused.short ? "true" : undefined}
          disabled={sidePaused.short}
          aria-disabled={sidePaused.short}
          aria-pressed={direction === "short"}
          className={`flex flex-1 flex-col items-center rounded-none border py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
            direction === "short"
              ? "border-[var(--short)] bg-[var(--short)] text-white"
              : "border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:border-[var(--short)]/40 hover:text-[var(--text)]"
          }`}
        >
          Short
          {sidePaused.short && (
            <span data-testid="trade-side-paused" className="text-[10px] font-medium normal-case tracking-normal">
              {TICKET_COPY.sidePausedSublabel}
            </span>
          )}
        </button>
      </div>

      {/* Size — single input + unit toggle, then ONE helper line: available | Max (tap = fill) */}
      <div className="mb-2">
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor="order-size-input" className="block text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">
            Size
          </label>
        </div>
        <div className="flex gap-1.5">
          <input
            id="order-size-input"
            data-testid="trade-size-input"
            type="text"
            inputMode="decimal"
            value={sizeInput}
            onChange={(e) => handleSizeChange(e.target.value)}
            placeholder={sizeUnit === "token" ? "0.0000" : "$0.00"}
            style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
            className={`flex-1 rounded-none border px-2 py-2 text-right text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:border-[var(--accent)] focus:ring-[var(--accent)]/20 ${
              exceedsBalance ? "border-[var(--warning)]/50" : "border-[var(--border)]/40"
            } bg-[var(--bg)]`}
          />
          <button
            onClick={toggleSizeUnit}
            data-testid="trade-size-unit"
            title={`Switch size unit (currently ${sizeUnit === "token" ? baseTicker : "USD"})`}
            className="w-16 shrink-0 truncate rounded-none border border-[var(--border)] bg-[var(--bg-elevated)] px-1 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-colors duration-150 hover:border-[var(--border-hover)] hover:text-[var(--text)]"
          >
            {sizeUnit === "token" ? baseTicker : "USD"}
          </button>
        </div>
        {clampedToQ !== null ? (
          <p
            data-testid="limits-clamp-notice"
            data-max-q={clampedToQ.toString()}
            title={clampReason || undefined}
            className="mt-1 text-[11px] text-[var(--warning)]"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {TICKET_COPY.clamped(livePriceE6 && livePriceE6 > 0n ? maxInUnit(clampedToQ, sizeUnit, livePriceE6, baseTicker).replace(` ${baseTicker}`, "") : fmtQ(clampedToQ), sizeUnit === "token" ? baseTicker : "USD")}
          </p>
        ) : (
          <div
            className="mt-1 flex items-center justify-between text-[11px]"
            style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
            title={lockedMargin > 0n ? `${formatTokenAmount(lockedMargin, decimals, 3)} ${collateralSymbol} backs your open position on this market` : undefined}
          >
            <span data-testid="ticket-available">
              <span className="text-[var(--text-secondary)]">Available </span>
              <span className="text-[var(--text)]">{accountPending ? "—" : formatTokenAmount(displayAvailable, decimals, 2)}</span>
              <span className="text-[var(--text-secondary)]"> {collateralSymbol}</span>
            </span>
            {maxLabel && (
              <button
                type="button"
                data-testid="limits-max-size-inline"
                data-side={direction}
                data-max-q={displayMaxQ!.toString()}
                data-unit={sizeUnit}
                title={clampReason || "The most you can open right now on this side."}
                onClick={() => fillFraction(100)}
                className="text-[var(--text-secondary)] hover:text-[var(--text)]"
              >
                Max <span className="text-[var(--text)]">{maxLabel}</span>
              </button>
            )}
          </div>
        )}
        {capital === 0n && (walletAtaBalance ?? 0n) > 0n && !fundingMode && (
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-secondary)]">
            {formatTokenAmount(walletAtaBalance ?? 0n, decimals, 2)} {collateralSymbol} in your wallet. Deposit it to start trading.
          </p>
        )}
      </div>
      <div className="mb-3 flex gap-1">
        {SIZE_PRESETS.map((pct) => (
          <button
            key={pct}
            onClick={() => fillFraction(pct)}
            data-testid="trade-size-preset"
            data-percent={pct}
            className="flex-1 rounded-none border border-[var(--border)]/30 py-1 text-[10px] font-medium text-[var(--text-secondary)] transition-colors duration-150 hover:border-[var(--accent)]/30 hover:bg-[var(--accent-subtle)] hover:text-[var(--text)]"
          >
            {pct === 100 ? "Max" : `${pct}%`}
          </button>
        ))}
      </div>

      {/* Leverage slider + input — divider matches the account row's border-t
          below, giving "size" and "leverage/risk" distinct visual sections
          instead of one continuous unbroken stack. */}
      <div className="mb-4 border-t border-[var(--border)]/20 pt-3">
        <div className="mb-1 flex items-center justify-between">
          <label htmlFor="order-leverage-input" className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">
            Leverage
            <InfoIcon tooltip="The multiplier used to size this order. On-chain margin params are the authoritative cap." />
          </label>
          <div className="flex items-center gap-1">
            <input
              id="order-leverage-input"
              data-testid="trade-leverage-input"
              type="text"
              inputMode="decimal"
              value={leverageText}
              onChange={(e) => {
                // GH#2628. Both halves matter and both are in the helper:
                // the text is kept verbatim so a "." survives long enough to
                // finish typing, and the value is quantised DOWN rather than
                // Math.round'ed up. See lib/leverage-control.ts.
                const next = nextLeverageInputState(e.target.value, maxLeverage);
                setLeverageText(next.text);
                if (next.leverage !== null) updateLeverageFromText(next.leverage);
              }}
              onBlur={() => setLeverageText(formatLeverageValue(leverage))}
              style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
              className="w-12 rounded-none border border-[var(--border)]/50 bg-[var(--bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--text)] focus:border-[var(--accent)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
            />
            <span className="text-[11px] font-medium text-[var(--text)]">x</span>
          </div>
        </div>
        {maxLeverage > 1 ? (() => {
          const n = availableLeverage.length;

          // Maps a leverage value → uniform display % — interpolates between
          // snap-point INDICES, not raw numeric values, so labels stay evenly
          // spaced regardless of the gap between them (e.g. 1/3/5/10/20 would
          // bunch up on a linear numeric scale; this keeps them uniform).
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

          return (
            <div className="relative pb-1">
              {/* Track wrapper — gives the invisible input a well-defined bounding box */}
              <div className="relative mx-0 mt-3 h-6">
                {/* Visual track line, vertically centred */}
                <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[var(--border)]/30">
                  {/* Fill */}
                  <div
                    className="absolute left-0 top-0 h-full rounded-full bg-[var(--accent)]"
                    style={{ width: `${thumbPct}%` }}
                  />
                </div>
                {/* Custom thumb — carries the keyboard focus ring since the
                    native input driving it is visually hidden below. */}
                <div
                  className={`pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--accent)] transition-shadow duration-150 ${
                    leverageFocused ? "ring-2 ring-offset-2 ring-offset-[var(--bg)] ring-[var(--accent)]" : "ring-2 ring-[var(--accent)]/30"
                  }`}
                  style={{ left: `${thumbPct}%` }}
                />
                {/* Invisible native input — same bounding box as the wrapper (h-6), handles all drag/click */}
                <input
                  type="range"
                  min={1}
                  max={maxLeverage}
                  step={LEVERAGE_STEP}
                  value={leverage}
                  onChange={(e) => {
                    // GH#2628: the snap-to-preset this replaced never fired — its
                    // reduce was seeded with `raw`, so no candidate could beat a
                    // starting distance of 0. It is removed rather than repaired:
                    // the computed radius was 1, which at a 0.5 step would pull
                    // every half-step near a preset onto it and make the finer
                    // step decorative. The presets are still one click away.
                    updateLeverage(clampSliderLeverage(Number(e.target.value), maxLeverage));
                  }}
                  onFocus={() => setLeverageFocused(true)}
                  onBlur={() => setLeverageFocused(false)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  style={{ height: "100%" }}
                  aria-label="Leverage"
                  data-testid="trade-leverage-slider"
                />
              </div>
              {/* Labels — uniformly spaced, one per snap point */}
              <div className="mt-2 flex justify-between">
                {availableLeverage.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => updateLeverage(l)}
                    data-testid="trade-leverage-preset"
                    data-leverage={l}
                    className={`-mx-2 px-2 text-[8px] font-mono transition-colors duration-100 ${
                      leverage === l
                        ? "text-[var(--accent)] font-bold"
                        : "text-[var(--text-dim)] hover:text-[var(--text-secondary)]"
                    }`}
                  >
                    {formatLeverageValue(l)}x
                  </button>
                ))}
              </div>
            </div>
          );
        })() : (
          <p className="text-[9px] text-[var(--text-dim)] font-mono">{formatLeverageValue(maxLeverage)}x (fixed)</p>
        )}
      </div>

      {stepDownNote && (
        <p
          data-testid="limits-stepdown-notice"
          data-max-leverage={String(ticketLimits.stepDown!.maxLeverage)}
          className="-mt-2 mb-3 text-[11px] leading-snug text-[var(--text-secondary)]"
        >
          {stepDownNote}
        </p>
      )}

      {/* Summary (§4.2): entry / liq / fee / margin. Everything else is in Details. */}
      {hasOrder && (
        <div className="mb-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]" data-testid="ticket-summary" style={{ fontVariantNumeric: "tabular-nums" }}>
          <SummaryCell label="Entry" value={formatUsdPriceE6(estEntry)} />
          <SummaryCell
            label="Liq. price"
            value={beforeLiqDisplay.text !== "—" && beforeLiqDisplay.text !== afterLiqDisplay.text ? `${beforeLiqDisplay.text} → ${afterLiqDisplay.text}` : afterLiqDisplay.text}
            valueClass={
              afterLiqDisplay.kind !== "price"
                ? "text-[var(--text-secondary)]"
                : direction === "long" ? "text-[var(--short)]" : "text-[var(--long)]"
            }
            tooltip={`Estimated liquidation price if this order fills at the estimated entry.${afterLiqDisplay.title ? ` ${afterLiqDisplay.title}` : ""}`}
          />
          <SummaryCell
            label="Fee"
            value={`${formatTokenAmount(fee, decimals)} ${collateralSymbol}`}
            /* A trader saw what they pay and nothing about where it goes. #2565. */
            tooltip={feeDestinationTitle}
          />
          <SummaryCell
            label="Margin"
            value={`${formatTokenAmount(marginNative, decimals)} ${collateralSymbol}`}
            tooltip="Collateral this order sets aside from your account to back the position, returned (plus or minus PnL) when it closes. Not a fee."
          />
        </div>
      )}

      {/* UX WP-6: the deposit that rides with this trade (margin + fee + 10%), editable. */}
      {fundingMode && hasOrder && (
        <div className="mb-2">
          <div className="flex items-center gap-1.5 border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5">
            <label htmlFor="first-trade-deposit" className="whitespace-nowrap text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]">
              Deposit
            </label>
            <input
              id="first-trade-deposit"
              data-testid="deposit-amount-input"
              type="text"
              inputMode="decimal"
              value={fundInput}
              placeholder={formatTokenAmount(fundNeededAtoms, decimals, 2)}
              onChange={(e) => setFundInput(sanitizeDecimalInput(e.target.value))}
              aria-label={`Deposit amount in ${collateralSymbol} for this trade`}
              className="w-full bg-transparent text-right text-[12px] text-[var(--text)] outline-none placeholder-[var(--text-secondary)]"
              style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
            />
            <button
              type="button"
              onClick={() => setFundInput(formatTokenAmount(walletAtaBalance ?? 0n, decimals))}
              aria-label="Deposit full wallet balance"
              className="text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] hover:underline"
            >
              Max
            </button>
            <span className="text-[10px] text-[var(--text-secondary)]">{collateralSymbol}</span>
          </div>
          {!fundOverWallet && !fundTooSmall && (
            <p data-testid="fund-explain" className="mt-1 text-[11px] leading-snug text-[var(--text-secondary)]">
              {`${belowImFloor ? `New positions on this market need at least $${usd2(imFloor, decimals).replace(/\.00$/, "")} of margin. ` : ""}Covers ${formatTokenAmount(marginShort, decimals, 2)} margin + fee for this ${formatTokenAmount(notionalNative, decimals, 2)} position${!needsAccount && !vsPosition && availableBalance > 0n ? `; ${formatTokenAmount(availableBalance, decimals, 2)} already on this market` : ""}. Anything unused stays in your account.`}
            </p>
          )}
          {fundOverWallet && (
            <p role="alert" data-testid="starter-deposit-error" className="mt-1 text-[11px] text-[var(--warning)]">
              {depositAmountMessage("exceeds", walletAtaBalance ?? 0n, decimals, collateralSymbol)}
            </p>
          )}
          {fundTooSmall && !fundOverWallet && (
            <p role="alert" data-testid="first-trade-deposit-too-small" className="mt-1 text-[11px] text-[var(--warning)]">
              {`This order needs at least ${formatTokenAmount(fundMinAtoms, decimals, 2)} ${collateralSymbol}.`}
            </p>
          )}
        </div>
      )}

      {/* Details drawer (§4.2): price band, quote breakdown, fee cap + margin, per-side limits
          with their reason, worst fill price, available before/after. Collapsed by default. */}
      <div className="mb-3">
        <button
          type="button"
          data-testid="ticket-details-toggle"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((v) => !v)}
          className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text)]"
        >
          Details {showDetails ? "▴" : "▾"}
        </button>
        {showDetails && (
          <div data-testid="ticket-details" className="mt-1.5 border border-[var(--border)]/40 bg-[var(--bg)]/60 px-2.5 py-2">
            {hasOrder && (
              <div className="mb-1 divide-y divide-[var(--border)]/30">
                <DiffRow
                  label="Worst fill price"
                  before="—"
                  after={slippageBoundE6 > 0n ? formatUsdPriceE6(slippageBoundE6) : "—"}
                  tooltip="Worst acceptable fill price sent on-chain: the trade is refused rather than fill worse than this."
                />
                <DiffRow
                  label="Available to trade"
                  before={`${formatTokenAmount(beforeAvailable, decimals)} ${collateralSymbol}`}
                  after={`${formatTokenAmount(afterAvailable, decimals)} ${collateralSymbol}`}
                  tooltip="Balance left for new orders after this one sets aside its margin."
                />
              </div>
            )}
            <OrderTicketLimits
              limits={marketLimits}
              ticket={ticketLimits}
              direction={direction}
              symbol={baseTicker}
              feeMarginBps={feeMarginBps}
              onFeeMarginChange={setFeeMarginBps}
            />
          </div>
        )}
      </div>

      </fieldset>

      {/* ONE big full-width submit */}
      {needsWallet ? (
        // Mode-aware connect CTA — mirrors app/faucet/page.tsx's connect-prompt
        // pattern. usePrivyLogin() alone is a no-op in the default wallet-adapter
        // deployment (no PrivyProvider mounted), which left this button dead.
        adapterAvailable ? (
          <div className="w-full [&>*]:w-full [&_button]:w-full [&_button]:rounded-none [&_button]:py-2.5 [&_button]:text-[11px] [&_button]:font-medium [&_button]:uppercase [&_button]:tracking-[0.1em]">
            <ConnectButton />
          </div>
        ) : privyAvailable ? (
          <button
            onClick={() => openWalletModal()}
            className="w-full rounded-none bg-[var(--accent)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-[filter] duration-150 hover:brightness-110"
          >
            Connect Wallet
          </button>
        ) : (
          <button
            disabled
            className="w-full cursor-not-allowed rounded-none bg-[var(--border)] py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]"
          >
            Wallet Unavailable
          </button>
        )
      ) : (needsAccount || needsDeposit) && !walletHasTokens ? (
        <>
          {(() => {
            const hasWalletTokens = (walletAtaBalance ?? 0n) > 0n;
            const canOneClick = needsAccount && hasWalletTokens && !showInlineDeposit;
            const bal = walletAtaBalance ?? 0n;
            const suggestedStarter = bal > 0n && bal < AUTO_DEPOSIT_AMOUNT ? bal : AUTO_DEPOSIT_AMOUNT;
            // The user chooses the starter deposit — read the editable field,
            // falling back to the suggested default when cleared. An amount
            // above the wallet balance is NOT silently clamped (that used to
            // deposit less than what was typed with no warning): it shows an
            // inline error and disables the CTA, like Withdraw does.
            const enteredStarter = starterAmountInput ? parsePercToNative(starterAmountInput, decimals) : 0n;
            const starterDeposit = enteredStarter > 0n ? enteredStarter : suggestedStarter;
            const starterOver = canOneClick && starterDeposit > bal;
            const starterError = starterOver
              ? depositAmountMessage("exceeds", bal, decimals, collateralSymbol)
              : null;
            const onClickDirect = async () => {
              if (starterOver) return;
              setInitCtaError(null);
              try {
                // PERC-onboarding-1: useInitUser folds Deposit into the SAME
                // account-creation transaction when possible — one click can
                // land a tradeable, funded account instead of always
                // requiring a second manual deposit afterward.
                await initUser(starterDeposit);
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                reportTxError(msg);
                if (!/user rejected|cancelled|denied/i.test(msg)) setInitCtaError(msg);
              }
            };
            // Single evolving CTA: one persistently-styled button whose label
            // always names the NEXT unblocking action — "Start Trading" now
            // covers account-creation + deposit in one click (fix #1), so
            // most users only ever see that single state once.
            const label = initLoading
              ? "Setting up your account…"
              : showInlineDeposit
                ? "Close"
                : canOneClick
                  ? "Start Trading"
                  : needsAccount
                    ? "Get Tokens to Trade"
                    : "Deposit to Trade";
            return (
              <>
                {canOneClick && (
                  <div className="mb-1.5 flex items-center gap-1.5 rounded-none border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5">
                    <label
                      htmlFor="starter-deposit-amount"
                      className="whitespace-nowrap text-[10px] uppercase tracking-[0.12em] text-[var(--text-secondary)]"
                    >
                      Deposit
                    </label>
                    <input
                      id="starter-deposit-amount"
                      data-testid="deposit-amount-input"
                      type="text"
                      inputMode="decimal"
                      value={starterAmountInput}
                      onChange={(e) => {
                        starterTouchedRef.current = true;
                        setStarterAmountInput(sanitizeDecimalInput(e.target.value));
                      }}
                      disabled={initLoading}
                      className="w-full bg-transparent text-right text-[12px] text-[var(--text)] outline-none placeholder-[var(--text-muted)]"
                      style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
                      placeholder={(Number(suggestedStarter) / 10 ** decimals).toString()}
                      aria-label={`Starter deposit amount in ${collateralSymbol}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        starterTouchedRef.current = true;
                        setStarterAmountInput(formatTokenAmount(bal, decimals));
                      }}
                      aria-label="Deposit full wallet balance"
                      disabled={initLoading}
                      className="text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] hover:underline disabled:opacity-50"
                    >
                      Max
                    </button>
                    <span className="text-[10px] text-[var(--text-secondary)]">{collateralSymbol}</span>
                  </div>
                )}
                {starterError && (
                  <p role="alert" data-testid="starter-deposit-error" className="mb-1.5 text-[10px] text-[var(--short)]">
                    {starterError}
                  </p>
                )}
                <button
                  data-testid="deposit-submit"
                  onClick={canOneClick ? onClickDirect : () => setShowInlineDeposit((v) => !v)}
                  disabled={initLoading || starterOver}
                  className={`w-full rounded-none py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-[filter] duration-150 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70 ${
                    direction === "long" ? "bg-[var(--long)] text-black" : "bg-[var(--short)] text-white"
                  }`}
                >
                  {label}
                </button>
              </>
            );
          })()}
          {(initCtaError || initError) && <p data-testid="deposit-error" className="mt-1 text-[10px] text-[var(--short)]">{initCtaError ?? initError}</p>}
          {showInlineDeposit && (
            <div className="mt-1.5" data-deposit-trigger>
              <DepositWithdrawCard slabAddress={slabAddress} />
            </div>
          )}
        </>
      ) : (
        <>
        {needsAccount && fundingMode && (
          <p data-testid="first-trade-line" className="mb-1.5 text-[11px] leading-snug text-[var(--text-secondary)]">
            {FIRST_TRADE_COPY.line}
          </p>
        )}
        <button
          data-testid="trade-submit"
          data-state={ticketState.row}
          data-funding={fundingMode ? "true" : undefined}
          onClick={() => {
            if (submitDisabled) return;
            // UX WP-6: more deposit than the wallet holds => get funds first (nothing to sign yet).
            if (fundOverWallet || (exceedsBalance && !fundingMode)) {
              toggleInlineDeposit("deposit");
              return;
            }
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
              estimatedLiqDisplay: afterLiqDisplay,
              tradingFee: fee,
              worstFillPriceE6,
              // The account after this trade: the resulting position and the bundled deposit, as
              // the liq row uses, over capital + deposit + pnl, as the position panel's Lev.
              riskLeverage: computeRiskLeverage(combinedSignedSize, livePriceE6 ?? 0n, capitalAfterFund + safeExistingPnl),
              depositAtoms: fundingMode && hasOrder ? fundAtoms : 0n,
            });
            setShowConfirmModal(true);
            // Prewarm the entire submission path (blockhash, priority fee,
            // v17 trade-account resolution) while the user reads the confirm
            // modal — their confirm click then reaches the wallet popup with
            // zero blocking RPC round-trips. Fire-and-forget.
            prewarmTradeSubmission(connection, slabProgramId, slabAddress, publicKey ?? null);
          }}
          disabled={submitDisabled}
          className={`w-full rounded-none py-3 text-[12px] font-bold uppercase tracking-[0.12em] transition-[filter] duration-150 hover:brightness-110 disabled:cursor-not-allowed disabled:hover:brightness-100 ${
            ticketState.blocks
              ? "bg-[var(--bg-elevated)] text-[var(--text-secondary)] disabled:opacity-100"
              : `disabled:opacity-50 ${direction === "long" ? "bg-[var(--long)] text-black" : "bg-[var(--short)] text-white"}`
          }`}
        >
          {(ticketState.waiting || tradePhase === "waiting") && (
            <span aria-hidden="true" data-testid="trade-submit-spinner" className="mr-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-current align-middle" />
          )}
          {tradePhase === "submitting"
            ? TICKET_COPY.confirmInWallet
            : tradePhase === "waiting"
              ? TICKET_COPY.waitingLatest
              : accountPending
                ? "Loading account…"
                : fundOverWallet && !ticketState.blocks
                ? "Get test funds"
                : fundingMode && ticketState.row === "ok"
                  ? FIRST_TRADE_COPY.button(fundLabel, direction === "long" ? "Long" : "Short")
                  : ticketState.buttonLabel}
        </button>
        </>
      )}

      {/* Account row: buying power / deposit link. Available balance is
          already shown compactly next to the Size input above ("Acc Bal") —
          repeating it here duplicated the same number under a different
          label; Buying Power is the one distinct figure worth a second look. */}
      <div className="mt-3 flex items-center justify-between border-t border-[var(--border)]/30 pt-2.5 text-[10px]">
        <div>
          <div className="flex items-center gap-1 text-[9px] uppercase tracking-[0.1em] text-[var(--text-secondary)]">
            Buying power
            <InfoIcon tooltip="Available balance x max leverage - the largest notional you could open right now." />
          </div>
          <div className="font-mono tabular-nums text-[var(--text)]">{accountPending ? "—" : formatTokenAmount(buyingPower, decimals)} {collateralSymbol}</div>
        </div>
        {connected && !accountPending && !needsAccount && !needsDeposit && (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              onClick={() => toggleInlineDeposit("deposit")}
              data-testid="deposit-toggle"
              className="rounded-sm border border-[var(--accent)]/50 bg-[var(--accent)]/[0.1] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--accent)] transition-all duration-150 hover:bg-[var(--accent)]/[0.18] hover:brightness-110"
            >
              + Deposit
            </button>
            <button
              onClick={() => toggleInlineDeposit("withdraw")}
              data-testid="withdraw-toggle"
              className="rounded-sm border border-[var(--long)]/50 bg-[var(--long)]/[0.1] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--long)] transition-all duration-150 hover:bg-[var(--long)]/[0.18] hover:brightness-110"
            >
              − Withdraw
            </button>
          </div>
        )}
      </div>
      {connected && !accountPending && showInlineDeposit && !((needsAccount || needsDeposit) && !walletHasTokens) && (
        <div className="mt-1.5" data-deposit-trigger>
          <DepositWithdrawCard slabAddress={slabAddress} initialMode={inlineDepositMode} offerFaucet={fundOverWallet} />
        </div>
      )}

      {getNetwork() === "mainnet" && (
        <div className="mt-3 border border-[var(--accent)]/30 bg-[var(--accent)]/[0.04] px-3 py-2 text-[10px] text-[var(--text)]">
          {formatLeverageValue(maxLeverage)}x max leverage enforced on-chain.
        </div>
      )}

      {showConfirmModal && confirmSnapshot && (
        <TradeConfirmationModal
          direction={direction}
          existingPositionSize={existingPositionSize}
          positionSize={confirmSnapshot.positionSize}
          margin={confirmSnapshot.marginNative}
          leverage={leverage}
          estimatedLiqPrice={confirmSnapshot.estimatedLiqPrice}
          estimatedLiqDisplay={confirmSnapshot.estimatedLiqDisplay}
          tradingFee={confirmSnapshot.tradingFee}
          worstFillPriceE6={confirmSnapshot.worstFillPriceE6}
          accountEquity={userAccount ? capital : null}
          riskLeverage={confirmSnapshot.riskLeverage}
          depositAmount={confirmSnapshot.depositAtoms}
          symbol={symbol}
          collateralSymbol={collateralSymbol}
          decimals={decimals}
          onConfirm={() => {
            const snapshot = confirmSnapshot;
            setShowConfirmModal(false);
            setConfirmSnapshot(null);
            void handleTrade(
              snapshot.positionSize,
              snapshot.worstFillPriceE6,
            );
          }}
          onCancel={() => { setShowConfirmModal(false); setConfirmSnapshot(null); }}
        />
      )}
    </div>
  );
};

/** Memoized export — see the file-header comment above `OrderTicketInner`. */
export const OrderTicket = memo(OrderTicketInner);
