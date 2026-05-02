"use client";

import { FC, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import gsap from "gsap";
import { useTrade } from "@/hooks/useTrade";
import { humanizeError, withTransientRetry } from "@/lib/errorMessages";
import { explorerTxUrl, getNetwork } from "@/lib/config";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { useOracleFreshness } from "@/hooks/useOracleFreshness";
import { AccountKind, computePreTradeLiqPrice, computeLiqPrice, computeMarkPnl, computePnlPercent } from "@percolatorct/sdk";
import { PreTradeSummary } from "@/components/trade/PreTradeSummary";
import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";
import { ClosePositionModal } from "@/components/trade/ClosePositionModal";
import { InfoIcon } from "@/components/ui/Tooltip";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { usePrivyLogin } from "@/hooks/usePrivySafe";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccountIdle } from "@/lib/mock-trade-data";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { formatTokenAmount, formatUsd } from "@/lib/format";
import { useClosePosition } from "@/hooks/useClosePosition";
import { saveEntryPrice, getEntryPrice, getEntryLeverage, clearEntryPrice } from "@/lib/entry-price";
import { isSentinelValue } from "@/lib/health";
import { DepositWithdrawCard } from "@/components/trade/DepositWithdrawCard";
import { useInitUser } from "@/hooks/useInitUser";

const LEVERAGE_SNAP_POINTS = [1, 2, 5, 10, 20];
const MARGIN_PRESETS = [25, 50, 75, 100];

/** GH#1483: Upper bound for UI leverage display. Clamps Supabase-sourced max_leverage
 *  to protect against DB corruption/keeper bugs. The Solana program enforces margin
 *  requirements at execution time regardless of what the UI slider shows. */
const MAX_DISPLAY_LEVERAGE = 200;

function formatPerc(native: bigint, decimals = 6): string {
  const abs = native < 0n ? -native : native;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const w = whole.toString();
  return frac ? `${w}.${frac}` : w;
}

function parsePercToNative(input: string, decimals = 6): bigint {
  const parts = input.split(".");
  if (parts.length > 2) return 0n; // reject "1.2.3"
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac);
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

function formatLeverageValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "1";
  return Number.isInteger(value) ? value.toString() : value.toFixed(1);
}

export const TradeForm: FC<{ slabAddress: string }> = ({ slabAddress }) => {
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
  const { priceUsd, priceE6: livePriceE6 } = useLivePrice();
  // GH#1330: Detect stale oracle to block trade submission before tx failure.
  // GH#1330/1338: Detect stale or unavailable oracle to block trade submission.
  // "stale" = price exists but hasn't updated recently (>30s).
  // "unavailable" = oracle has never been cranked (no valid price on-chain).
  // Both are hard blocks — same UX as no-price — to prevent "Oracle is invalid" on-chain rejection.
  const { level: oracleLevel, mode: oracleMode, ready: oracleReady } = useOracleFreshness();
  const oracleUnavailable = oracleLevel === "unavailable";
  const oracleStale = oracleUnavailable || (oracleReady && oracleLevel === "stale" && (oracleMode === "admin" || oracleMode === "hyperp"));
  const openWalletModal = usePrivyLogin();
  const mintAddress = mktConfig?.collateralMint?.toBase58() ?? "";
  const collateralSymbol = sanitizeSymbol(tokenMeta?.symbol, mintAddress);
  
  // BUG FIX: Fetch on-chain decimals from token account (like DepositWithdrawCard)
  // Don't rely solely on tokenMeta which may fail for cross-network tokens
  const [onChainDecimals, setOnChainDecimals] = useState<number | null>(null);
  const decimals = onChainDecimals ?? tokenMeta?.decimals ?? 6;

  // GH#1133: Wallet ATA balance — shown in Bal: when no user account exists yet
  // (before CreateAccount+Deposit; capital=0n from null userAccount is misleading)
  const [walletAtaBalance, setWalletAtaBalance] = useState<bigint | null>(null);
  
  const prefersReduced = usePrefersReducedMotion();

  // Risk reduction gate detection
  const riskThreshold = params?.riskReductionThreshold ?? 0n;
  const vaultBalance = engine?.vault ?? 0n;
  // Also check insurance fund balance — on Hyperp markets, the seed capital goes
  // to the vault token account but engine.vault only tracks trader deposits.
  // The insurance fund balance or the actual vault ATA balance indicates real liquidity.
  const insuranceBalance = engine?.insuranceFund?.balance ?? 0n;
  const riskGateActive = riskThreshold > 0n && vaultBalance <= riskThreshold;

  // GH#1272: Vault-empty guard — when engine is loaded but vault = 0, no trades can
  // execute on-chain (no LP counterparty). Without this guard the button appears
  // clickable but the transaction fails silently with no user feedback.
  // Only active once engine is loaded (engine !== null) to avoid false positives
  // during the initial loading phase where vault defaults to 0n.
  // FIX: Also check insuranceBalance — Hyperp markets seed the vault via direct
  // SPL transfer which doesn't increment engine.vault but the funds ARE available.
  // Also check Supabase vault_balance as fallback for markets where the indexer
  // has read the actual token account balance.
  // FIX: On Hyperp markets (oracle_authority=[0;32]), seed capital is deposited via
  // direct SPL transfer to the vault ATA, which doesn't increment engine.vault.
  // The program reads the actual vault token account during trades, so engine.vault=0
  // does NOT mean "no liquidity". Only show the empty-vault guard when BOTH the
  // engine vault AND insurance fund are empty AND it's not a Hyperp market.
  // For Hyperp markets, the vault ATA always has seed capital from InitMarket.
  const isHyperp = mktConfig?.oracleAuthority?.toBase58() === "11111111111111111111111111111111";
  const vaultEmpty = engine !== null && vaultBalance === 0n && insuranceBalance === 0n && !isHyperp && !mockMode;

  const [direction, setDirection] = useState<"long" | "short">("long");
  const [marginInput, setMarginInput] = useState("");
  // Dual size input: "contracts" (token units) or "usdc" (USD value)
  const [sizeMode, setSizeMode] = useState<"contracts" | "usdc">("contracts");
  const [contractsInput, setContractsInput] = useState("");
  const [usdcInput, setUsdcInput] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [leverageText, setLeverageText] = useState("1");
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [tradePhase, setTradePhase] = useState<"idle" | "submitting" | "confirming">("idle");
  const [humanError, setHumanError] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  // Snapshot modal props when opening to prevent live price updates from
  // causing re-renders / flicker while the confirmation modal is open.
  const [confirmSnapshot, setConfirmSnapshot] = useState<{
    positionSize: bigint;
    marginNative: bigint;
    estimatedLiqPrice: bigint;
    tradingFee: bigint;
  } | null>(null);
  const [showCloseModal, setShowCloseModal] = useState(false);
  // Inline deposit form. Only rendered as a *fallback* — when the user has
  // zero collateral tokens in their wallet (and therefore needs the faucet
  // button inside DepositWithdrawCard), or when they already have an account
  // but zero capital (rare — requires picking a deposit amount). The common
  // case (connected wallet + tokens + no account) is handled by a direct
  // one-click initUser call below, so the button itself opens the wallet.
  const [showInlineDeposit, setShowInlineDeposit] = useState(false);

  // Direct one-click account creation. initUser(0n) auto-bumps feePayment to
  // (newAccountFee + minInitialDeposit), so the user ends up with a registered
  // sub-account AND the minimum required capital in a single tx.
  const { initUser, loading: initLoading, error: initError } = useInitUser(slabAddress);
  const [initCtaError, setInitCtaError] = useState<string | null>(null);

  const longBtnRef = useRef<HTMLButtonElement>(null);
  const shortBtnRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const lpEntry = useMemo(() => {
    return accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null;
  }, [accounts]);
  const lpIdx = lpEntry?.idx ?? 0;
  const hasValidLP = lpEntry !== null;

  // Bug #267a67ef: Detect when LP has insufficient capital to accept trades.
  // If LP capital is 0 (or below minimum margin for any trade), the on-chain
  // program will reject trades with Custom(14) Undercollateralized on the LP side.
  const lpUnderfunded = hasValidLP && lpEntry!.account.capital === 0n;

  // GH#1480: Bug #845 — many devnet slabs have initialMarginBps=0 due to init bug.
  // On-chain margin params are the authoritative hard cap for leverage.
  // Supabase max_leverage is advisory metadata — used ONLY as fallback when on-chain
  // data is unavailable (uninitialised slab / initialMarginBps == 0).
  // GH#1962: Fix — do NOT use max(on-chain, Supabase). Supabase must never loosen the cap.
  const { market: marketInfo } = useMarketInfo(slabAddress);
  // BUG FIX: Use Supabase market symbol for the trading pair display (e.g. "SOL"),
  // falling back to collateral symbol. Prevents "USDC/USD" when the market is actually SOL/USD.
  const symbol = marketInfo?.symbol ?? collateralSymbol;
  const initialMarginBps = params?.initialMarginBps ?? 1000n;
  const maintenanceMarginBps = params?.maintenanceMarginBps ?? 500n;
  const tradingFeeBps = params?.tradingFeeBps ?? 30n;
  // Clamp to minimum 1 — if initialMarginBps > 10000 (>100% margin), integer division yields
  // 0 which breaks the slider (min=1 > max=0) and causes the "1x and 0x simultaneously" bug.
  // GH#1480: When initialMarginBps is 0 (uninitialised slab), on-chain gives 0 — fall back to Supabase.
  const maxLeverageFromOnChain = initialMarginBps > 0n ? Math.max(1, Number(10000n / initialMarginBps)) : 0;
  // Supabase value is advisory — only used when on-chain is unavailable (0).
  // NEVER used to relax an on-chain cap (GH#1962).
  const supabaseLeverage = Number(marketInfo?.max_leverage) || 0;
  const rawMaxLeverage =
    maxLeverageFromOnChain > 0
      ? maxLeverageFromOnChain          // on-chain is authoritative
      : supabaseLeverage || 1;          // fallback: Supabase (uninitialised slab only)
  // GH#1483: Clamp to MAX_DISPLAY_LEVERAGE — protects against corrupt DB values.
  // Program enforces real margin requirements at execution time.
  const maxLeverage = Math.min(MAX_DISPLAY_LEVERAGE, rawMaxLeverage);

  const availableLeverage = useMemo(() => {
    const arr = LEVERAGE_SNAP_POINTS.filter((l) => l <= maxLeverage);
    if (arr.length === 0 || arr[arr.length - 1] < maxLeverage) {
      arr.push(maxLeverage);
    }
    return arr;
  }, [maxLeverage]);

  const capital = userAccount ? userAccount.account.capital : 0n;
  const existingPosition = userAccount ? userAccount.account.positionSize : 0n;
  const hasPosition = existingPosition !== 0n;

  // Auto-close the inline deposit form the moment a deposit lands on-chain
  // (capital transitions 0 → >0). Without this, the user has to manually
  // dismiss the card after seeing the confirmation tx, which feels janky.
  const prevCapitalRef = useRef<bigint>(capital);
  useEffect(() => {
    if (prevCapitalRef.current === 0n && capital > 0n) {
      setShowInlineDeposit(false);
    }
    prevCapitalRef.current = capital;
  }, [capital]);

  // GH#1133: When no trading account exists yet, use wallet ATA balance as the
  // effective balance for validation (exceedsMargin, %-presets, Max button).
  // capital=0n from a null userAccount is misleading — the user may have tokens
  // in their wallet that they'll deposit to create their account.
  const effectiveBalance = userAccount ? capital : (walletAtaBalance ?? 0n);

  // ── Dual size input (USDC ↔ contracts) ─────────────────────────────────────
  // marginInput drives the legacy path. The dual size input computes contracts
  // from position notional = contracts, margin = notional / leverage.
  // When user edits contracts: derive USDC (= contracts * priceUsd) and margin.
  // When user edits USDC: derive contracts (= usdc / priceUsd) and margin.
  const handleContractsChange = useCallback((val: string) => {
    setContractsInput(val.replace(/[^0-9.]/g, ""));
    const n = parseFloat(val);
    if (!isNaN(n) && priceUsd && priceUsd > 0) {
      const notionalUsd = n * priceUsd;
      setUsdcInput(notionalUsd.toFixed(2));
      // margin (in collateral) = notional_usd / leverage
      const marginAmt = notionalUsd / leverage;
      setMarginInput(marginAmt.toFixed(decimals));
    } else if (val === "" || val === ".") {
      setUsdcInput("");
      setMarginInput("");
    }
  }, [priceUsd, leverage, decimals]);

  const handleUsdcChange = useCallback((val: string) => {
    setUsdcInput(val.replace(/[^0-9.]/g, ""));
    const usd = parseFloat(val);
    if (!isNaN(usd) && priceUsd && priceUsd > 0) {
      const contracts = usd / priceUsd;
      setContractsInput(contracts.toFixed(6));
      // margin (in collateral) = notional_usd / leverage
      const marginAmt = usd / leverage;
      setMarginInput(marginAmt.toFixed(decimals));
    } else if (val === "" || val === ".") {
      setContractsInput("");
      setMarginInput("");
    }
  }, [priceUsd, leverage, decimals]);

  // Re-sync margin when leverage changes (contracts stay fixed, margin = notional / leverage)
  // Re-sync margin when leverage changes (contracts stay fixed, use current price)
  const priceRef = useRef(priceUsd);
  priceRef.current = priceUsd;
  const prevLeverageRef = useRef(leverage);
  useEffect(() => {
    if (prevLeverageRef.current === leverage) return;
    prevLeverageRef.current = leverage;
    if (!contractsInput) return;
    const n = parseFloat(contractsInput);
    const price = priceRef.current;
    if (!isNaN(n) && n > 0 && price && price > 0) {
      const notionalUsd = n * price;
      const marginAmt = notionalUsd / leverage;
      setMarginInput(marginAmt.toFixed(decimals));
      setUsdcInput(notionalUsd.toFixed(2));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leverage]);

  // ── Position card data ───────────────────────────────────────────────────────
  const openPositionSize = existingPosition;
  const hasOpenPosition = openPositionSize !== 0n;
  const isOpenLong = openPositionSize > 0n;
  const rawOpenEntryPrice = userAccount?.account.entryPrice ?? 0n;
  // V12_1: entry_price removed from on-chain struct. Fall back to saved entry price.
  const savedOpenEntryPrice = rawOpenEntryPrice > 0n ? 0n : (userAccount ? getEntryPrice(slabAddress, userAccount.idx) : 0n);
  const openEntryPriceE6 = rawOpenEntryPrice > 0n ? rawOpenEntryPrice : (savedOpenEntryPrice > 0n ? savedOpenEntryPrice : 0n);
  const openCapital = userAccount?.account.capital ?? 0n;
  const openLiqPriceE6 = hasOpenPosition && openEntryPriceE6 > 0n
    ? computeLiqPrice(openEntryPriceE6, openCapital, openPositionSize, maintenanceMarginBps)
    : 0n;
  const resolvedOpenEntry = openEntryPriceE6 > 0n ? openEntryPriceE6 : 0n;
  const openPnlTokens = hasOpenPosition && livePriceE6 && livePriceE6 > 0n && resolvedOpenEntry > 0n
    ? computeMarkPnl(openPositionSize, resolvedOpenEntry, livePriceE6)
    : (userAccount?.account.pnl !== undefined && !isSentinelValue(userAccount.account.pnl) ? userAccount.account.pnl : 0n);
  const openPnlPercent = hasOpenPosition ? computePnlPercent(openPnlTokens, openCapital) : 0;
  // Liq danger: within 20% of mark
  const openLiqDanger = (() => {
    if (!livePriceE6 || livePriceE6 <= 0n || openLiqPriceE6 <= 0n) return false;
    const dist = Math.abs(Number(livePriceE6) - Number(openLiqPriceE6)) / Number(livePriceE6);
    return dist < 0.20;
  })();
  const savedOpenLeverage = userAccount ? getEntryLeverage(slabAddress, userAccount.idx) : null;
  const openAccountLeverage = hasOpenPosition && openCapital > 0n && livePriceE6 && livePriceE6 > 0n
    ? Math.max(1, Number((abs(openPositionSize) * livePriceE6) / 1_000_000n) / Number(openCapital))
    : 1;
  const openDisplayLeverage = savedOpenLeverage ?? openAccountLeverage;
  const openLeverageTitle = savedOpenLeverage != null
    ? `Selected order leverage. Account leverage is ${formatLeverageValue(openAccountLeverage)}x because all deposited collateral counts toward liquidation.`
    : "Account leverage: position notional divided by total deposited collateral.";
  const { closePosition, loading: closeLoading } = useClosePosition(slabAddress);

  const marginNative = marginInput ? parsePercToNative(marginInput, decimals) : 0n;
  // Position size = contracts (index asset units), NOT USDC.
  // Coin-margined: notional_usdc = margin × leverage, then contracts = notional / markPrice.
  // Without price division, a "1 USDC" input sends 1M units on-chain which the program
  // interprets as 1M × $80 = $80M notional — causing undercollateralized errors.
  const notionalNative = marginNative * BigInt(leverage);
  const rawPositionSize = livePriceE6 && livePriceE6 > 0n
    ? (notionalNative * 1_000_000n) / livePriceE6
    : 0n;
  const positionSize = rawPositionSize < 0n ? 0n : rawPositionSize;
  
  // GH#1133: Use effectiveBalance (wallet ATA when no account) so input isn't
  // immediately flagged as "exceeds balance" before the user creates an account.
  const exceedsMargin = marginNative > 0n && marginNative > effectiveBalance;

  const setMarginPercent = useCallback(
    (pct: number) => {
      if (effectiveBalance <= 0n) return;
      let amount = (effectiveBalance * BigInt(pct)) / 100n;
      // Prevent truncation to 0 for small balances — use at least 1 native unit
      // when the percentage of a non-zero capital would otherwise round to zero
      if (amount === 0n && pct > 0) amount = 1n;
      const marginStr = formatPerc(amount, decimals);
      setMarginInput(marginStr);
      // Sync dual size inputs: notional = margin * leverage, contracts = notional / price
      const marginNum = Number(amount) / Math.pow(10, decimals);
      const notionalUsd = marginNum * leverage;
      if (priceUsd && priceUsd > 0) {
        const contracts = notionalUsd / priceUsd;
        setContractsInput(contracts.toFixed(6));
        setUsdcInput(notionalUsd.toFixed(2));
      } else {
        setContractsInput("");
        setUsdcInput(notionalUsd.toFixed(2));
      }
    },
    [effectiveBalance, decimals, leverage, priceUsd]
  );

  // Dynamic slider: when the user moves the leverage slider, keep the committed
  // margin fixed and recompute notional/size so the slider's number equals the
  // effective leverage on the trade. Without this, the slider only changes the
  // summary math silently while the size inputs stay stale from the previous
  // leverage setting.
  const updateLeverage = useCallback(
    (newLev: number) => {
      setLeverage(newLev);
      setLeverageText(String(newLev));
      // If user already sized the position via margin, recompute size fields.
      if (!marginInput) return;
      const marginNumRaw = parseFloat(marginInput);
      if (!Number.isFinite(marginNumRaw) || marginNumRaw <= 0) return;
      const notionalUsd = marginNumRaw * newLev;
      if (priceUsd && priceUsd > 0) {
        const contracts = notionalUsd / priceUsd;
        setContractsInput(contracts.toFixed(6));
        setUsdcInput(notionalUsd.toFixed(2));
      } else {
        setContractsInput("");
        setUsdcInput(notionalUsd.toFixed(2));
      }
    },
    [marginInput, priceUsd],
  );

  // BUG FIX: Fetch on-chain decimals AND wallet ATA balance from user's token account.
  // Decimals: ensures correct precision for cross-network tokens or missing metadata.
  // Wallet balance (GH#1133): show real wallet balance when no trading account exists yet.
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
        // Token account may not exist yet (no wallet balance), keep using fallback decimals
        if (!cancelled) { setOnChainDecimals(null); setWalletAtaBalance(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [publicKey, mktConfig?.collateralMint, connection, mockMode]);

  // Reset form state when switching markets (bug #1a12dab5)
  useEffect(() => {
    setDirection("long");
    setMarginInput("");
    setContractsInput("");
    setUsdcInput("");
    setLeverage(1);
    setLastSig(null);
    setHumanError(null);
    setTradePhase("idle");
  }, [slabAddress]);

  // Direction toggle GSAP bounce
  useEffect(() => {
    if (prefersReduced) return;
    const target = direction === "long" ? longBtnRef.current : shortBtnRef.current;
    if (!target) return;
    gsap.fromTo(
      target,
      { scale: 1.05 },
      { scale: 1, duration: 0.5, ease: "elastic.out(1, 0.4)" }
    );
  }, [direction, prefersReduced]);

  // Error message GSAP expand animation
  useEffect(() => {
    if (!humanError || prefersReduced) return;
    const el = errorRef.current;
    if (!el) return;
    gsap.fromTo(
      el,
      { height: 0, opacity: 0, overflow: "hidden" },
      { height: "auto", opacity: 1, duration: 0.35, ease: "power2.out" }
    );
  }, [humanError, prefersReduced]);

  // Determine what the submit button should do
  const needsWallet = !connected;
  const needsAccount = connected && !userAccount;
  const needsDeposit = connected && userAccount && capital === 0n;
  const canTrade = connected && userAccount && capital > 0n && !lpUnderfunded;

  async function handleTrade(snapshotSize?: bigint) {
    // Use the snapshotted size from the confirmation modal so the submitted
    // trade matches what the user reviewed, even if the live price moved
    // between modal-open and confirm. Fall back to live size if no snapshot
    // (e.g. mock mode or non-confirm code paths).
    const effectiveSize = snapshotSize ?? positionSize;
    if (!marginInput || !userAccount || effectiveSize <= 0n || exceedsMargin) return;

    if (mockMode) {
      setTradePhase("submitting");
      setTimeout(() => { setTradePhase("confirming"); setMarginInput(""); }, 800);
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
      const sig = await withTransientRetry(
        async () => trade({ lpIdx, userIdx: userAccount!.idx, size }),
        { maxRetries: 2, delayMs: 3000 },
      );
      setTradePhase("confirming");
      setLastSig(sig ?? null);
      setMarginInput("");
      // V12_1: entry_price removed from on-chain struct. Save mark price at
      // trade time so the frontend can compute unrealized PnL.
      if (livePriceE6 && livePriceE6 > 0n && userAccount) {
        saveEntryPrice(slabAddress, userAccount.idx, livePriceE6, leverage);
      }
      // GH#trading-race: Single delayed refresh — give the on-chain state
      // time to settle before re-polling. Avoids the double-refresh that
      // causes provider state thrashing and modal flicker.
      setTimeout(() => {
        refreshSlab();
        setTradePhase("idle");
      }, 1500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[TradeForm] raw error:", msg);
      setHumanError(humanizeError(msg));
      setTradePhase("idle");
    }
  }

  return (
    <div className="relative rounded-none bg-[var(--bg)]/80 border border-[var(--border)]/50 p-3">

      {/* GH#1272: Vault-empty warning — shown when no LP has deposited. Prevents
          silent button failures by surfacing the real reason trading is blocked. */}
      {vaultEmpty && (
        <div className="mb-3 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">No Vault Liquidity</p>
          <p className="mt-1 text-[9px] text-[var(--text-secondary)] leading-relaxed">
            This market has no LP deposits. Trading will be enabled once liquidity is added to the vault.
          </p>
        </div>
      )}

      {/* LP underfunded warning */}
      {lpUnderfunded && !vaultEmpty && (
        <div className="mb-3 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">Liquidity Unavailable</p>
          <p className="mt-1 text-[9px] text-[var(--text-secondary)] leading-relaxed">
            The LP has no capital. Trades cannot execute until the LP is funded.
          </p>
        </div>
      )}

      {/* ── Open Position Card (replaces simple banner) ── */}
      {hasOpenPosition && userAccount && (
        <div className="mb-3 rounded-none border border-cyan-500/30 bg-cyan-950/30 p-3.5">
          {/* Header row */}
          <div className="mb-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-bold uppercase tracking-[0.1em] ${isOpenLong ? "text-green-400" : "text-red-400"}`}>
                {isOpenLong ? "LONG" : "SHORT"}
              </span>
              <span className="text-[10px] text-[var(--text-dim)]">{symbol}/USD</span>
              <span
                className="text-[10px] font-bold text-cyan-400"
                style={{ fontFamily: "var(--font-mono)" }}
                title={openLeverageTitle}
              >
                {formatLeverageValue(openDisplayLeverage)}x
              </span>
            </div>
            <button
              onClick={() => setShowCloseModal(true)}
              className="rounded-none border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.1em] text-red-400 transition-colors hover:bg-red-500/20"
            >
              Close
            </button>
          </div>
          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px]">
            <div>
              <span className="text-[var(--text-dim)] uppercase tracking-[0.08em]">Entry</span>
              <span className="ml-2 font-mono font-medium text-[var(--text)]">
                {openEntryPriceE6 > 0n ? formatUsd(openEntryPriceE6) : "—"}
              </span>
            </div>
            <div>
              <span className={`uppercase tracking-[0.08em] ${openLiqDanger ? "text-orange-400" : "text-[var(--text-dim)]"}`}>
                Liq {openLiqDanger ? "⚠" : ""}
              </span>
              <span className={`ml-2 font-mono font-medium ${openLiqDanger ? "text-orange-400" : "text-[var(--text)]"}`}>
                {openLiqPriceE6 > 0n ? formatUsd(openLiqPriceE6) : "—"}
              </span>
            </div>
            <div>
              <span className="text-[var(--text-dim)] uppercase tracking-[0.08em]">Size</span>
              <span className="ml-2 font-mono font-medium text-[var(--text)]">
                {formatTokenAmount(abs(openPositionSize), decimals)} {symbol}
              </span>
            </div>
            <div>
              <span className="text-[var(--text-dim)] uppercase tracking-[0.08em]">PnL</span>
              <span className={`ml-2 font-mono font-medium ${openPnlTokens > 0n ? "text-green-400" : openPnlTokens < 0n ? "text-red-400" : "text-[var(--text-muted)]"}`}>
                {openPnlTokens >= 0n ? "+" : ""}{formatTokenAmount(openPnlTokens, decimals)}
                <span className="ml-1 text-[9px]">({openPnlPercent >= 0 ? "+" : ""}{openPnlPercent.toFixed(2)}%)</span>
              </span>
            </div>
          </div>
          {/* Action buttons */}
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            <button
              onClick={() => {
                const deposit = document.querySelector('[data-deposit-trigger]');
                if (deposit) deposit.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }}
              className="rounded-none border border-[var(--border)] py-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)] transition-colors hover:border-cyan-500/30 hover:text-cyan-400"
            >
              Add Margin
            </button>
            <button
              onClick={() => setShowCloseModal(true)}
              className="rounded-none bg-red-500/80 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-white transition-colors hover:bg-red-500"
            >
              Close Position
            </button>
          </div>
        </div>
      )}

      {/* Market paused banner */}
      {header?.paused && (
        <div className="mb-3 rounded-none border border-[var(--short)]/30 bg-[var(--short)]/5 p-3 text-center">
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--short)]">⛔ MARKET PAUSED</p>
          <p className="mt-1 text-[10px] text-[var(--short)]/70">
            Trading, deposits, and withdrawals are disabled by the market admin.
          </p>
        </div>
      )}

      {/* Risk gate warning */}
      {riskGateActive && (
        <div className="mb-3 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
          <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-[var(--warning)]">Risk Reduction Mode</p>
          <p className="mt-1 text-[10px] text-[var(--warning)]/70">
            This market is in de-risking mode. Only closing trades are allowed right now.
          </p>
        </div>
      )}

      {/* No oracle price warning — trading requires a valid oracle price to calculate
          PnL and liquidation levels. When priceUsd is null (WebSocket not connected or
          oracle feed unavailable), we disable the trade button to prevent 0-price
          transactions that would fail on-chain with a cryptic error. */}
      {!priceUsd && !mockMode && (
        <div className="mb-3 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">No Oracle Price</p>
          <p className="mt-1 text-[9px] text-[var(--text-secondary)] leading-relaxed">
            Waiting for price feed. Trades will be enabled once oracle data is available.
          </p>
        </div>
      )}

      {/* GH#1330/1338: Oracle warning — stale or unavailable oracle blocks trading.
          "unavailable" = oracle never cranked (no price on-chain, e.g. test tokens without a feed).
          "stale" = price exists but hasn't updated recently. Both prevent "Oracle is invalid" tx failure.
          P3-5: Use consistent amber/orange design language matching OracleFreshnessIndicator warning strip. */}
      {oracleStale && !mockMode && (
        <div className="mb-3 rounded-none border border-amber-500/30 bg-amber-500/[0.07] p-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-amber-400">
            {oracleUnavailable ? "⚠ Oracle Unavailable" : "⚠ Oracle Stale"}
          </p>
          <p className="mt-1 text-[9px] text-[var(--text-secondary)] leading-relaxed">
            {oracleUnavailable
              ? "Oracle not yet active — keeper has not cranked this market."
              : "The oracle price for this market has not been updated recently. Trading is temporarily disabled to prevent failed transactions."}
          </p>
        </div>
      )}

      {/* Order type indicator — market orders only */}
      <div className="mb-3 flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Order Type</span>
        <span className="rounded-none border border-[var(--accent)]/30 bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--accent)]">
          Market
        </span>
      </div>

      {/* Direction toggle */}
      <div className="mb-3 flex gap-1">
        <button
          ref={longBtnRef}
          onClick={() => setDirection("long")}
          className={`flex-1 rounded-none py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-all duration-150 ${
            direction === "long"
              ? "bg-green-500 border border-green-500 text-black"
              : "border border-[var(--border)] bg-[var(--bg-surface)] text-[var(--text-dim)]"
          }`}
        >
          Long
        </button>
        <button
          ref={shortBtnRef}
          onClick={() => setDirection("short")}
          className={`flex-1 rounded-none py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] transition-all duration-150 ${
            direction === "short"
              ? "bg-red-500 border border-red-500 text-white"
              : "border border-red-400/60 bg-red-500/[0.08] text-red-400 hover:bg-red-500/20 hover:border-red-400/80"
          }`}
        >
          Short
        </button>
      </div>

      {/* ── Dual size input (contracts ↔ USDC) ── */}
      <div className="mb-2">
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Size<InfoIcon tooltip="Position size — enter in contracts (tokens) or USD. Both fields sync automatically." /></label>
          <span className="text-[10px] text-[var(--text-dim)] whitespace-nowrap min-w-0 shrink-0" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            Bal: {userAccount ? formatPerc(capital, decimals) : (walletAtaBalance !== null ? formatPerc(walletAtaBalance, decimals) : "—")} {collateralSymbol}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          {/* Contracts input */}
          <div>
            <div className="relative">
              <input
                type="text"
                value={contractsInput}
                onChange={(e) => handleContractsChange(e.target.value)}
                onFocus={() => setSizeMode("contracts")}
                placeholder="0.000000"
                style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
                className={`w-full rounded-none border px-2 py-2 text-right text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 ${
                  sizeMode === "contracts"
                    ? "border-[var(--accent)]/50 bg-[var(--bg)] focus:border-[var(--accent)] focus:ring-[var(--accent)]/20"
                    : "border-[var(--border)]/40 bg-[var(--bg)] focus:border-[var(--accent)]/30 focus:ring-[var(--accent)]/10"
                } ${exceedsMargin ? "border-[var(--short)]/50 bg-[var(--short)]/5" : ""}`}
              />
            </div>
            <span className="mt-0.5 block text-center text-[10px] text-[var(--text-dim)] uppercase tracking-[0.1em]">{symbol}</span>
          </div>
          {/* USDC input */}
          <div>
            <div className="relative">
              <input
                type="text"
                value={usdcInput}
                onChange={(e) => handleUsdcChange(e.target.value)}
                onFocus={() => setSizeMode("usdc")}
                placeholder="$0.00"
                style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
                className={`w-full rounded-none border px-2 py-2 text-right text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 ${
                  sizeMode === "usdc"
                    ? "border-[var(--accent)]/50 bg-[var(--bg)] focus:border-[var(--accent)] focus:ring-[var(--accent)]/20"
                    : "border-[var(--border)]/40 bg-[var(--bg)] focus:border-[var(--accent)]/30 focus:ring-[var(--accent)]/10"
                }`}
              />
            </div>
            <span className="mt-0.5 block text-center text-[10px] text-[var(--text-dim)] uppercase tracking-[0.1em]">USD</span>
          </div>
        </div>
        {exceedsMargin && (
          <p className="mt-1 text-[10px] text-[var(--short)]" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
            Exceeds balance ({formatPerc(effectiveBalance, decimals)} {collateralSymbol})
          </p>
        )}
      </div>

      {/* Quick-fill percentage row */}
      <div className="mb-3 flex gap-1">
        {MARGIN_PRESETS.map((pct) => (
          <button
            key={pct}
            onClick={() => setMarginPercent(pct)}
            className="flex-1 rounded-none border border-[var(--border)]/30 py-1 text-[10px] font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--text-secondary)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]/30"
          >
            {pct === 100 ? "MAX" : `${pct}%`}
          </button>
        ))}
      </div>

      {/* Leverage slider + presets */}
      <div className="mb-5">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Leverage<InfoIcon tooltip="Multiplies your position size. 5x leverage means 5x the profit but also 5x the loss. Higher leverage = higher risk of liquidation." /></label>
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={leverageText}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9.]/g, "");
                setLeverageText(raw);
                const parsed = parseFloat(raw);
                if (!isNaN(parsed)) {
                  const clamped = Math.max(1, Math.min(maxLeverage, Math.round(parsed)));
                  updateLeverage(clamped);
                }
              }}
              onBlur={() => {
                // Normalise display on blur
                setLeverageText(String(leverage));
              }}
              style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}
              className="w-12 rounded-none border border-[var(--border)]/50 bg-[var(--bg)] px-1.5 py-0.5 text-right text-[11px] text-[var(--text)] focus:border-[var(--accent)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--accent)]/20"
            />
            <span className="text-[11px] font-medium text-[var(--text-dim)]">x</span>
          </div>
        </div>
        <input
          type="range"
          min={1}
          max={maxLeverage}
          step={1}
          value={leverage}
          onChange={(e) => {
            const val = Number(e.target.value);
            updateLeverage(val);
          }}
          style={{
            background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${maxLeverage > 1 ? ((leverage - 1) / (maxLeverage - 1)) * 100 : 100}%, var(--bg-surface) ${maxLeverage > 1 ? ((leverage - 1) / (maxLeverage - 1)) * 100 : 100}%, var(--bg-surface) 100%)`,
          }}
          className="mb-3 h-1.5 w-full cursor-pointer appearance-none touch-none accent-[var(--accent)] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[var(--bg-surface)] [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:shadow-[0_0_6px_rgba(153,69,255,0.4)] [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--accent)] [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[var(--bg-surface)]"
        />
        <div className="flex flex-wrap gap-1">
          {availableLeverage.map((l) => (
            <button
              key={l}
              onClick={() => updateLeverage(l)}
              className={`flex-1 basis-0 min-w-[32px] rounded-none py-1.5 min-h-[36px] text-[9px] font-medium transition-all duration-150 focus-visible:ring-1 focus-visible:ring-[var(--accent)]/30 touch-manipulation ${
                leverage === l
                  ? "bg-[var(--accent)] text-white"
                  : "border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)]/50 hover:text-[var(--text-secondary)]"
              }`}
            >
              {l}x
            </button>
          ))}
        </div>
      </div>

      {/* Mainnet Phase 1 Guards */}
      {getNetwork() === "mainnet" && (
        <div className="mb-5 border border-[var(--accent)]/30 bg-[var(--accent)]/[0.04] px-4 py-3 text-[11px] space-y-1">
          <p className="text-[var(--accent)] font-medium">⚡ Mainnet Phase 1 Guards Active</p>
          <p className="text-[var(--text-muted)]">• $10K OI cap per market during beta</p>
          <p className="text-[var(--text-muted)]">• {maxLeverage}x max leverage enforced on-chain</p>
          <p className="text-[var(--text-muted)]">• Guards auto-lift when caps are raised by DAO</p>
        </div>
      )}

      {/* Pre-trade summary */}
      {marginInput && marginNative > 0n && !exceedsMargin && (
        <PreTradeSummary
          oracleE6={priceUsd ? BigInt(Math.round(priceUsd * 1e6)) : 0n}
          margin={marginNative}
          positionSize={positionSize}
          direction={direction}
          leverage={leverage}
          tradingFeeBps={tradingFeeBps}
          maintenanceMarginBps={maintenanceMarginBps}
          symbol={symbol}
          collateralSymbol={collateralSymbol}
          decimals={decimals}
          accountEquity={userAccount ? capital : null}
        />
      )}

      {/* Submit */}
      {needsWallet ? (
        <button
          onClick={() => openWalletModal()}
          className="w-full rounded-none py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-all duration-150 hover:scale-[1.01] active:scale-[0.99] bg-[var(--accent)] hover:brightness-110 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)] focus-visible:ring-[var(--accent)]"
        >
          Connect Wallet
        </button>
      ) : needsAccount || needsDeposit ? (
        <>
          {(() => {
            // One-click path: user has an unspent collateral balance in their
            // wallet and just needs to create the sub-account. initUser with a
            // 0 hint bumps feePayment to the on-chain minimum, so a single tx
            // registers the slot AND deposits minInitialDeposit as capital.
            // The user will then see the top "Account" balance bar appear and
            // can top up further without going through this CTA again.
            const hasWalletTokens = (walletAtaBalance ?? 0n) > 0n;
            const canOneClick = needsAccount && hasWalletTokens && !showInlineDeposit;
            const onClickDirect = async () => {
              setInitCtaError(null);
              try {
                await initUser(0n);
                // On success, useInitUser refreshes the slab; userAccount will
                // populate on the next poll and this whole branch unmounts.
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                // User-rejected wallet signatures shouldn't surface as errors.
                if (!/user rejected|cancelled|denied/i.test(msg)) {
                  setInitCtaError(msg);
                }
              }
            };
            return (
              <button
                onClick={canOneClick ? onClickDirect : () => setShowInlineDeposit((v) => !v)}
                disabled={initLoading}
                aria-expanded={showInlineDeposit}
                className={`w-full rounded-none py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-black transition-all duration-150 hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-70 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)] ${
                  direction === "long"
                    ? "bg-green-500 hover:bg-green-400 focus-visible:ring-green-500"
                    : "bg-red-500 hover:bg-red-400 focus-visible:ring-red-500"
                }`}
              >
                {initLoading
                  ? "Creating account…"
                  : showInlineDeposit
                  ? "Close"
                  : canOneClick
                  ? "Create Account & Deposit"
                  : needsAccount
                  ? "Get Tokens to Trade"
                  : "Deposit to Trade"}
              </button>
            );
          })()}
          {(initCtaError || initError) && (
            <p className="mt-1 text-[10px] text-[var(--short)]">{initCtaError ?? initError}</p>
          )}
          {showInlineDeposit && (
            <div className="mt-1.5">
              <DepositWithdrawCard slabAddress={slabAddress} />
            </div>
          )}
        </>
      ) : (
        <button
          onClick={() => {
            if (!marginInput || !userAccount || positionSize <= 0n || exceedsMargin || riskGateActive || header?.paused || tradePhase !== "idle" || loading || (!priceUsd && !mockMode) || (oracleStale && !mockMode)) return;
            // Snapshot all price-dependent values so the modal doesn't flicker
            // when WebSocket price updates arrive while it's open.
            const oracleE6 = priceUsd ? BigInt(Math.round(priceUsd * 1e6)) : 0n;
            setConfirmSnapshot({
              positionSize,
              marginNative,
              estimatedLiqPrice: computePreTradeLiqPrice(oracleE6, marginNative, positionSize, maintenanceMarginBps, tradingFeeBps, direction),
              tradingFee: livePriceE6 && livePriceE6 > 0n ? ((positionSize * livePriceE6 / 1_000_000n) * tradingFeeBps) / 10000n : 0n,
            });
            setShowConfirmModal(true);
          }}
          disabled={tradePhase !== "idle" || loading || !marginInput || positionSize <= 0n || exceedsMargin || riskGateActive || header?.paused || lpUnderfunded || vaultEmpty || (!priceUsd && !mockMode) || (oracleStale && !mockMode)}
          className={`w-full rounded-none py-2.5 text-[11px] font-bold uppercase tracking-[0.1em] text-black transition-all duration-150 hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)] ${
            direction === "long"
              ? "bg-green-500 hover:bg-green-400 focus-visible:ring-green-500"
              : "bg-red-500 hover:bg-red-400 focus-visible:ring-red-500"
          }`}
        >
          {tradePhase === "submitting" ? (
            <span className="inline-flex items-center gap-2">
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              Submitting…
            </span>
          ) : tradePhase === "confirming" ? (
            <span className="inline-flex items-center gap-2">
              <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
              Confirmed!
            </span>
          ) : (
            `${direction === "long" ? "Long" : "Short"} ${leverage}x`
          )}
        </button>
      )}

      {humanError && (
        <div ref={errorRef} className="mt-2 rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
          <p className="text-[10px] text-[var(--short)]">{humanError}</p>
        </div>
      )}

      {lastSig && (
        <p className="mt-2 text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
          Tx:{" "}
          <a
            href={`${explorerTxUrl(lastSig)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--accent)] hover:underline"
          >
            {lastSig.slice(0, 16)}...
          </a>
        </p>
      )}

      {/* Coin-margined info — compact tooltip hint */}
      <div className="mt-3 flex items-center gap-1.5">
        <InfoIcon tooltip={`This market is margined in ${collateralSymbol}, not USD. Position value and liq risk are affected by the collateral token's price. Effective USD leverage ≈ ${leverage > 0 ? `${leverage * 2}x` : "—"} (nominal ${leverage}x × 2 for coin exposure).`} />
        <InfoIcon tooltip={`This market is margined in ${symbol}, not USD. Position value and liq risk are affected by the collateral token's price. Selected leverage: ${leverage > 0 ? `${leverage}x` : "—"}.`} />
        <span className="text-[9px] text-[var(--text-dim)] uppercase tracking-[0.1em]">Coin-margined market</span>
      </div>

      {/* Close position modal */}
      {/* Latch: don't unmount modal when hasOpenPosition briefly goes false
          during slab refresh after close. showCloseModal is the sole dismiss gate. */}
      {showCloseModal && userAccount && (
        <ClosePositionModal
          positionSize={openPositionSize}
          entryPrice={openEntryPriceE6}
          currentPrice={livePriceE6 ?? 0n}
          capital={openCapital}
          symbol={symbol}
          collateralSymbol={collateralSymbol}
          decimals={decimals}
          priceUsd={priceUsd}
          isLong={isOpenLong}
          loading={closeLoading}
          oracleStale={oracleStale && !mockMode}
          onConfirm={async (percent) => {
            await closePosition(percent);
            // Clear saved entry price on full close
            if (percent === 100 && userAccount) {
              clearEntryPrice(slabAddress, userAccount.idx);
            }
            // Delay modal close until after slab refresh settles.
            refreshSlab();
            setTimeout(() => { setShowCloseModal(false); refreshSlab(); }, 1500);
          }}
          onCancel={() => setShowCloseModal(false)}
        />
      )}

      {/* Trade confirmation modal — uses snapshotted values to prevent
          flicker from live price updates while the modal is open. */}
      {showConfirmModal && confirmSnapshot && (
        <TradeConfirmationModal
          direction={direction}
          positionSize={confirmSnapshot.positionSize}
          margin={confirmSnapshot.marginNative}
          leverage={leverage}
          estimatedLiqPrice={confirmSnapshot.estimatedLiqPrice}
          tradingFee={confirmSnapshot.tradingFee}
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
