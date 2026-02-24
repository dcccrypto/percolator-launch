"use client";

import { FC, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import gsap from "gsap";
import { useTrade } from "@/hooks/useTrade";
import { humanizeError, withTransientRetry } from "@/lib/errorMessages";
import { explorerTxUrl } from "@/lib/config";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { AccountKind, computePreTradeLiqPrice } from "@percolator/sdk";
import { PreTradeSummary } from "@/components/trade/PreTradeSummary";
import { TradeConfirmationModal } from "@/components/trade/TradeConfirmationModal";
import { InfoIcon } from "@/components/ui/Tooltip";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { usePrivyLogin } from "@/hooks/usePrivySafe";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab, getMockUserAccountIdle } from "@/lib/mock-trade-data";

const LEVERAGE_PRESETS = [1, 2, 3, 5, 10];
const MARGIN_PRESETS = [25, 50, 75, 100];

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

export const TradeForm: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { connected: walletConnected, publicKey } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const realUserAccount = useUserAccount();
  const mockMode = isMockMode() && isMockSlab(slabAddress);
  const connected = walletConnected || mockMode;
  const userAccount = realUserAccount ?? (mockMode ? getMockUserAccountIdle(slabAddress) : null);
  const { trade, loading, error } = useTrade(slabAddress);
  const { engine, params } = useEngineState();
  const { accounts, config: mktConfig, header } = useSlabState();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const { priceUsd } = useLivePrice();
  const openWalletModal = usePrivyLogin();
  const symbol = tokenMeta?.symbol ?? "Token";
  
  // BUG FIX: Fetch on-chain decimals from token account (like DepositWithdrawCard)
  // Don't rely solely on tokenMeta which may fail for cross-network tokens
  const [onChainDecimals, setOnChainDecimals] = useState<number | null>(null);
  const decimals = onChainDecimals ?? tokenMeta?.decimals ?? 6;
  
  const prefersReduced = usePrefersReducedMotion();

  // Risk reduction gate detection
  const riskThreshold = params?.riskReductionThreshold ?? 0n;
  const vaultBalance = engine?.vault ?? 0n;
  const riskGateActive = riskThreshold > 0n && vaultBalance <= riskThreshold;

  const [direction, setDirection] = useState<"long" | "short">("long");
  const [marginInput, setMarginInput] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [tradePhase, setTradePhase] = useState<"idle" | "submitting" | "confirming">("idle");
  const [humanError, setHumanError] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

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

  const initialMarginBps = params?.initialMarginBps ?? 1000n;
  const maintenanceMarginBps = params?.maintenanceMarginBps ?? 500n;
  const tradingFeeBps = params?.tradingFeeBps ?? 30n;
  const maxLeverage = initialMarginBps > 0n ? Number(10000n / initialMarginBps) : 1;

  const availableLeverage = useMemo(() => {
    const arr = LEVERAGE_PRESETS.filter((l) => l <= maxLeverage);
    if (arr.length === 0 || arr[arr.length - 1] < maxLeverage) {
      arr.push(maxLeverage);
    }
    return arr;
  }, [maxLeverage]);

  const capital = userAccount ? userAccount.account.capital : 0n;
  const existingPosition = userAccount ? userAccount.account.positionSize : 0n;
  const hasPosition = existingPosition !== 0n;

  const marginNative = marginInput ? parsePercToNative(marginInput, decimals) : 0n;
  // Defensive clamp: positionSize should never be negative, but guard anyway
  const rawPositionSize = marginNative * BigInt(leverage);
  const positionSize = rawPositionSize < 0n ? 0n : rawPositionSize;
  
  const exceedsMargin = marginNative > 0n && marginNative > capital;

  const setMarginPercent = useCallback(
    (pct: number) => {
      if (capital <= 0n) return;
      let amount = (capital * BigInt(pct)) / 100n;
      // Prevent truncation to 0 for small balances — use at least 1 native unit
      // when the percentage of a non-zero capital would otherwise round to zero
      if (amount === 0n && pct > 0) amount = 1n;
      setMarginInput(formatPerc(amount, decimals));
    },
    [capital, decimals]
  );

  // BUG FIX: Fetch on-chain decimals from user's token account
  // This ensures correct decimals even for cross-network tokens or missing metadata
  useEffect(() => {
    if (!publicKey || !mktConfig?.collateralMint || mockMode) {
      setOnChainDecimals(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(mktConfig.collateralMint, publicKey);
        const info = await connection.getTokenAccountBalance(ata);
        if (!cancelled && info.value.decimals !== undefined) {
          setOnChainDecimals(info.value.decimals);
        }
      } catch {
        // Token account may not exist yet, keep using fallback decimals
        if (!cancelled) setOnChainDecimals(null);
      }
    })();
    return () => { cancelled = true; };
  }, [publicKey, mktConfig?.collateralMint, connection, mockMode]);

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

  async function handleTrade() {
    if (!marginInput || !userAccount || positionSize <= 0n || exceedsMargin) return;

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
      const size = direction === "short" ? -positionSize : positionSize;
      const sig = await withTransientRetry(
        async () => trade({ lpIdx, userIdx: userAccount!.idx, size }),
        { maxRetries: 2, delayMs: 3000 },
      );
      setTradePhase("confirming");
      setLastSig(sig ?? null);
      setMarginInput("");
      setTimeout(() => setTradePhase("idle"), 2000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[TradeForm] raw error:", msg);
      setHumanError(humanizeError(msg));
      setTradePhase("idle");
    }
  }

  return (
    <div className="relative rounded-none bg-[var(--bg)]/80 border border-[var(--border)]/50 p-3">

      {/* LP underfunded warning */}
      {lpUnderfunded && (
        <div className="mb-3 rounded-none border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--warning)]">Liquidity Unavailable</p>
          <p className="mt-1 text-[9px] text-[var(--text-secondary)] leading-relaxed">
            The LP has no capital. Trades cannot execute until the LP is funded.
          </p>
        </div>
      )}

      {/* Position open banner */}
      {hasPosition && (
        <div className="mb-3 rounded-none border border-[var(--accent)]/20 bg-[var(--accent)]/5 p-2.5">
          <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-[var(--accent)]">Position Open</p>
          <p className="mt-1 text-[9px] text-[var(--text-secondary)]">
            Close from the positions table below. You can still place new trades.
          </p>
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

      {/* Direction toggle */}
      <div className="mb-3 flex gap-1">
        <button
          ref={longBtnRef}
          onClick={() => setDirection("long")}
          className={`flex-1 rounded-none py-2 text-[11px] font-medium uppercase tracking-[0.1em] transition-all duration-150 ${
            direction === "long"
              ? "border border-[var(--long)]/60 text-[var(--long)] bg-[var(--long)]/8 shadow-[0_0_12px_rgba(20,241,149,0.1)]"
              : "border border-[var(--border)]/30 text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border)]"
          }`}
        >
          Long
        </button>
        <button
          ref={shortBtnRef}
          onClick={() => setDirection("short")}
          className={`flex-1 rounded-none py-2 text-[11px] font-medium uppercase tracking-[0.1em] transition-all duration-150 ${
            direction === "short"
              ? "border border-[var(--short)]/60 text-[var(--short)] bg-[var(--short)]/8 shadow-[0_0_12px_rgba(255,59,92,0.1)]"
              : "border border-[var(--border)]/30 text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border)]"
          }`}
        >
          Short
        </button>
      </div>

      {/* Margin input */}
      <div className="mb-2">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Margin ({symbol})<InfoIcon tooltip="The amount of collateral you're putting up for this trade. If your position loses more than your margin, you get liquidated." /></label>
          <span className="text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
            Bal: {formatPerc(capital, decimals)}
          </span>
        </div>
        <div className="relative">
          <input
            type="text"
            value={marginInput}
            onChange={(e) => setMarginInput(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.00"
            style={{ fontFamily: "var(--font-mono)" }}
            className={`w-full rounded-none border px-3 py-2 pr-14 text-sm text-[var(--text)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 ${
              exceedsMargin
                ? "border-[var(--short)]/50 bg-[var(--short)]/5 focus:border-[var(--short)] focus:ring-[var(--short)]/30"
                : "border-[var(--border)]/50 bg-[var(--bg)] focus:border-[var(--accent)]/50 focus:ring-[var(--accent)]/20"
            }`}
          />
          <button
            onClick={() => {
              if (capital > 0n) setMarginInput(formatPerc(capital, decimals));
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-none bg-[var(--accent)]/10 px-2 py-0.5 text-[9px] font-medium uppercase tracking-wider text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20"
          >
            Max
          </button>
        </div>
        {exceedsMargin && (
          <p className="mt-1 text-[10px] text-[var(--short)]" style={{ fontFamily: "var(--font-mono)" }}>
            Exceeds balance ({formatPerc(capital, decimals)} {symbol})
          </p>
        )}
      </div>

      {/* Margin percentage row */}
      <div className="mb-3 flex gap-1">
        {MARGIN_PRESETS.map((pct) => (
          <button
            key={pct}
            onClick={() => setMarginPercent(pct)}
            className="flex-1 rounded-none border border-[var(--border)]/30 py-1 text-[10px] font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--text-secondary)] focus-visible:ring-1 focus-visible:ring-[var(--accent)]/30"
          >
            {pct}%
          </button>
        ))}
      </div>

      {/* Leverage slider + presets */}
      <div className="mb-5">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Leverage<InfoIcon tooltip="Multiplies your position size. 5x leverage means 5x the profit but also 5x the loss. Higher leverage = higher risk of liquidation." /></label>
          <span className="text-[11px] font-medium text-[var(--text)]" style={{ fontFamily: "var(--font-mono)" }}>{leverage}x</span>
        </div>
        <input
          type="range"
          min={1}
          max={maxLeverage}
          step={1}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
          style={{
            background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${maxLeverage > 1 ? ((leverage - 1) / (maxLeverage - 1)) * 100 : 100}%, rgba(255,255,255,0.03) ${maxLeverage > 1 ? ((leverage - 1) / (maxLeverage - 1)) * 100 : 100}%, rgba(255,255,255,0.03) 100%)`,
          }}
          className="mb-3 h-1 w-full cursor-pointer appearance-none accent-[var(--accent)] [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-[var(--accent)]"
        />
        <div className="flex gap-1">
          {availableLeverage.map((l) => (
            <button
              key={l}
              onClick={() => setLeverage(l)}
              className={`flex-1 rounded-none py-1 text-[10px] font-medium transition-all duration-150 focus-visible:ring-1 focus-visible:ring-[var(--accent)]/30 ${
                leverage === l
                  ? "bg-[var(--accent)] text-white"
                  : "border border-[var(--border)]/30 text-[var(--text-muted)] hover:border-[var(--accent)]/30 hover:text-[var(--text-secondary)]"
              }`}
            >
              {l}x
            </button>
          ))}
        </div>
      </div>

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
          decimals={decimals}
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
        <button
          onClick={() => {
            // Scroll to the deposit trigger above the form
            const deposit = document.querySelector('[data-deposit-trigger]');
            if (deposit) deposit.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}
          className={`w-full rounded-none py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-all duration-150 hover:scale-[1.01] active:scale-[0.99] focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)] ${
            direction === "long"
              ? "bg-[var(--long)] hover:brightness-110 focus-visible:ring-[var(--long)]"
              : "bg-[var(--short)] hover:brightness-110 focus-visible:ring-[var(--short)]"
          }`}
        >
          {needsAccount ? "Create Account & Deposit" : "Deposit to Trade"}
        </button>
      ) : (
        <button
          onClick={() => {
            if (!marginInput || !userAccount || positionSize <= 0n || exceedsMargin || riskGateActive || header?.paused || tradePhase !== "idle" || loading) return;
            setShowConfirmModal(true);
          }}
          disabled={tradePhase !== "idle" || loading || !marginInput || positionSize <= 0n || exceedsMargin || riskGateActive || header?.paused || lpUnderfunded}
          className={`w-full rounded-none py-2.5 text-[11px] font-medium uppercase tracking-[0.1em] text-white transition-all duration-150 hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)] ${
            direction === "long"
              ? "bg-[var(--long)] hover:brightness-110 focus-visible:ring-[var(--long)]"
              : "bg-[var(--short)] hover:brightness-110 focus-visible:ring-[var(--short)]"
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
        <p className="mt-2 text-[10px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-mono)" }}>
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

      {/* Coin-margined info */}
      <div className="mt-3 rounded-none border border-[var(--border)]/20 bg-[var(--bg)]/50 p-2.5">
        <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)]">
          Coin-Margined Market
        </p>
        <p className="mt-1 text-[9px] leading-relaxed text-[var(--text-muted)]">
          Margined in <strong className="text-[var(--text-secondary)]">{symbol}</strong>, not USD. Position value and liquidation risk are affected by {symbol} price movements.
          Effective USD leverage: <span className="font-mono text-[var(--text-secondary)]">{leverage > 0 ? `~${leverage * 2}x` : "—"}</span> (nominal {leverage}x × 2 for coin exposure).
        </p>
      </div>

      {/* Trade confirmation modal */}
      {showConfirmModal && marginNative > 0n && positionSize > 0n && (
        <TradeConfirmationModal
          direction={direction}
          positionSize={positionSize}
          margin={marginNative}
          leverage={leverage}
          estimatedLiqPrice={computePreTradeLiqPrice(
            priceUsd ? BigInt(Math.round(priceUsd * 1e6)) : 0n,
            marginNative,
            positionSize,
            maintenanceMarginBps,
            tradingFeeBps,
            direction,
          )}
          tradingFee={(positionSize * tradingFeeBps) / 10000n}
          symbol={symbol}
          decimals={decimals}
          onConfirm={() => {
            setShowConfirmModal(false);
            handleTrade();
          }}
          onCancel={() => setShowConfirmModal(false)}
        />
      )}
    </div>
  );
};
