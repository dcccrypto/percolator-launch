"use client";

import { FC, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import gsap from "gsap";
import { useTrade } from "@/hooks/useTrade";
import { humanizeError, withTransientRetry } from "@/lib/errorMessages";
import { explorerTxUrl } from "@/lib/config";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { AccountKind } from "@percolator/core";
import { PreTradeSummary } from "@/components/trade/PreTradeSummary";
import { InfoIcon } from "@/components/ui/Tooltip";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

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
  const { connected } = useWallet();
  const userAccount = useUserAccount();
  const { trade, loading, error } = useTrade(slabAddress);
  const { engine, params } = useEngineState();
  const { accounts, config: mktConfig, header } = useSlabState();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const { priceUsd } = useLivePrice();
  const symbol = tokenMeta?.symbol ?? "Token";
  const decimals = tokenMeta?.decimals ?? 6;
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

  const longBtnRef = useRef<HTMLButtonElement>(null);
  const shortBtnRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const lpEntry = useMemo(() => {
    return accounts.find(({ account }) => account.kind === AccountKind.LP) ?? null;
  }, [accounts]);
  const lpIdx = lpEntry?.idx ?? 0;
  const hasValidLP = lpEntry !== null;

  const initialMarginBps = params?.initialMarginBps ?? 1000n;
  const maintenanceMarginBps = params?.maintenanceMarginBps ?? 500n;
  const tradingFeeBps = params?.tradingFeeBps ?? 30n;
  const maxLeverage = Number(10000n / initialMarginBps);

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
  const positionSize = marginNative * BigInt(leverage);
  const exceedsMargin = marginNative > 0n && marginNative > capital;

  const setMarginPercent = useCallback(
    (pct: number) => {
      if (capital <= 0n) return;
      const amount = (capital * BigInt(pct)) / 100n;
      setMarginInput(formatPerc(amount, decimals));
    },
    [capital]
  );

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

  // Keyboard shortcut
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "BUTTON")) {
          return;
        }
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  if (!connected) {
    return (
      <div className="rounded-sm bg-[var(--panel-bg)] border border-[var(--border)] p-6 text-center">
        <p className="text-[var(--text-secondary)]">Connect your wallet to trade</p>
      </div>
    );
  }

  if (!userAccount) {
    return (
      <div className="rounded-sm bg-[var(--panel-bg)] border border-[var(--border)] p-6 text-center">
        <p className="text-[var(--text-secondary)]">
          No trading account yet. Use the <strong className="text-[var(--text)]">Create Account</strong> button in the Deposit panel on the right to get started.
        </p>
      </div>
    );
  }

  if (!hasValidLP) {
    return (
      <div className="rounded-sm bg-[var(--panel-bg)] border border-[var(--border)] p-6 text-center">
        <p className="text-[var(--text-secondary)]">
          No liquidity provider found for this market. Trading is not available until an LP initializes a vAMM.
        </p>
      </div>
    );
  }

  if (hasPosition) {
    return (
      <div className="rounded-sm bg-[var(--panel-bg)] border border-[var(--border)] p-6">
        <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          Trade
        </h3>
        <div className="rounded-sm border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-4 text-sm text-[var(--warning)]">
          <p className="font-medium">Position open</p>
          <p className="mt-1 text-xs text-[var(--warning)]/60">
            You have an open {existingPosition > 0n ? "LONG" : "SHORT"} of{" "}
            {formatPerc(abs(existingPosition), decimals)} {symbol}.
            Close your position before opening a new one.
          </p>
        </div>
      </div>
    );
  }

  async function handleTrade() {
    if (!marginInput || !userAccount || positionSize <= 0n || exceedsMargin) return;
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
    <div className="rounded-sm bg-[var(--panel-bg)] border border-[var(--border)] p-6">
      <h3 className="mb-4 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
        Trade
      </h3>

      {/* Market paused banner */}
      {header?.paused && (
        <div className="mb-4 rounded-sm border border-[var(--short)]/30 bg-[var(--short)]/10 p-4 text-center">
          <p className="text-sm font-bold text-[var(--short)]">⛔ MARKET PAUSED</p>
          <p className="mt-1 text-xs text-[var(--short)]/70">
            Trading, deposits, and withdrawals are disabled by the market admin.
          </p>
        </div>
      )}

      {/* Risk gate warning */}
      {riskGateActive && (
        <div className="mb-4 rounded-sm border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-3">
          <p className="text-xs font-medium text-[var(--warning)]">Risk Reduction Mode</p>
          <p className="mt-1 text-[10px] text-[var(--warning)]/70">
            This market is in de-risking mode. Only closing trades are allowed right now.
            The market admin can reset this from My Markets.
          </p>
        </div>
      )}

      {/* Direction toggle */}
      <div className="mb-4 flex gap-2">
        <button
          ref={longBtnRef}
          onClick={() => setDirection("long")}
          className={`flex-1 rounded-sm py-2.5 text-sm font-medium transition-all duration-150 ${
            direction === "long"
              ? "border border-[var(--long)] text-[var(--long)] bg-[var(--long)]/10"
              : "bg-white/5 text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.08] hover:text-[var(--text)]"
          }`}
        >
          Long
        </button>
        <button
          ref={shortBtnRef}
          onClick={() => setDirection("short")}
          className={`flex-1 rounded-sm py-2.5 text-sm font-medium transition-all duration-150 ${
            direction === "short"
              ? "border border-[var(--short)] text-[var(--short)] bg-[var(--short)]/10"
              : "bg-white/5 text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.08] hover:text-[var(--text)]"
          }`}
        >
          Short
        </button>
      </div>

      {/* Margin input */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-[var(--text-secondary)]">Margin ({symbol})<InfoIcon tooltip="The amount of collateral you're putting up for this trade. If your position loses more than your margin, you get liquidated." /></label>
          <span className="text-xs text-[var(--text-secondary)]">
            Balance: <span className="text-[var(--text-secondary)]">{formatPerc(capital, decimals)}</span>
          </span>
        </div>
        <div className="relative">
          <input
            type="text"
            value={marginInput}
            onChange={(e) => setMarginInput(e.target.value.replace(/[^0-9.]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleTrade();
            }}
            placeholder="0.00"
            className={`w-full rounded-sm border px-3 py-2.5 pr-14 text-[var(--text)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus-visible:ring-2 ${
              exceedsMargin
                ? "border-[var(--short)]/50 bg-[var(--short)]/10 focus:border-[var(--short)] focus:ring-[var(--short)]/30"
                : "border-[var(--border)] bg-[var(--bg-surface)] focus:border-[var(--accent)] focus:ring-[var(--accent)]/30"
            }`}
          />
          <button
            onClick={() => {
              if (capital > 0n) setMarginInput(formatPerc(capital, decimals));
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-[var(--accent-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20"
          >
            Max
          </button>
        </div>
        {exceedsMargin && (
          <p className="mt-1 text-xs text-[var(--short)]">
            Exceeds balance ({formatPerc(capital, decimals)} {symbol})
          </p>
        )}
      </div>

      {/* Margin percentage row */}
      <div className="mb-4 flex gap-1.5">
        {MARGIN_PRESETS.map((pct) => (
          <button
            key={pct}
            onClick={() => setMarginPercent(pct)}
            className="flex-1 rounded-sm bg-white/5 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--accent)]/[0.08] hover:text-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]/30"
          >
            {pct}%
          </button>
        ))}
      </div>

      {/* Leverage slider + presets */}
      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-[var(--text-secondary)]">Leverage<InfoIcon tooltip="Multiplies your position size. 5x leverage means 5x the profit but also 5x the loss. Higher leverage = higher risk of liquidation." /></label>
          <span className="text-xs font-medium text-[var(--text)]">{leverage}x</span>
        </div>
        <input
          type="range"
          min={1}
          max={maxLeverage}
          step={1}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
          style={{
            background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${maxLeverage > 1 ? ((leverage - 1) / (maxLeverage - 1)) * 100 : 100}%, rgba(255,255,255,0.05) ${maxLeverage > 1 ? ((leverage - 1) / (maxLeverage - 1)) * 100 : 100}%, rgba(255,255,255,0.05) 100%)`,
          }}
          className="mb-2 h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[var(--accent)] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)]"
        />
        <div className="flex gap-1.5">
          {availableLeverage.map((l) => (
            <button
              key={l}
              onClick={() => setLeverage(l)}
              className={`flex-1 rounded-sm py-1.5 text-xs font-medium transition-all duration-150 focus-visible:ring-2 focus-visible:ring-[var(--accent)]/30 ${
                leverage === l
                  ? "bg-[var(--accent)] text-white shadow-sm"
                  : "bg-white/5 text-[var(--text-secondary)] hover:bg-[var(--accent)]/[0.08]"
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
        />
      )}

      {/* Submit */}
      <button
        onClick={handleTrade}
        disabled={tradePhase !== "idle" || loading || !marginInput || positionSize <= 0n || exceedsMargin || riskGateActive}
        className={`w-full rounded-sm py-3 text-sm font-medium text-white transition-all duration-150 hover:scale-[1.01] active:scale-[0.99] transition-transform disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 disabled:active:scale-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)] ${
          direction === "long"
            ? "bg-[var(--long)] hover:brightness-110 focus-visible:ring-[var(--long)]"
            : "bg-[var(--short)] hover:brightness-110 focus-visible:ring-[var(--short)]"
        }`}
      >
        {tradePhase === "submitting" ? (
          <span className="inline-flex items-center gap-2">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            Submitting…
          </span>
        ) : tradePhase === "confirming" ? (
          <span className="inline-flex items-center gap-2">
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/></svg>
            Confirmed!
          </span>
        ) : (
          `${direction === "long" ? "Long" : "Short"} ${leverage}x`
        )}
      </button>
      <p className="mt-1.5 text-center text-[11px] text-[var(--text-muted)]">
        Press Enter to submit
      </p>

      {humanError && (
        <div ref={errorRef} className="mt-2 rounded-sm border border-[var(--short)]/20 bg-[var(--short)]/10 px-3 py-2">
          <p className="text-xs text-[var(--short)]">{humanError}</p>
        </div>
      )}

      {lastSig && (
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
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
    </div>
  );
};
