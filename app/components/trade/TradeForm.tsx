"use client";

import { FC, useState, useMemo, useCallback, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
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

const LEVERAGE_PRESETS = [1, 2, 3, 5, 10];
const MARGIN_PRESETS = [25, 50, 75, 100];

function formatPerc(native: bigint): string {
  const abs = native < 0n ? -native : native;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const w = whole.toLocaleString();
  return frac ? `${w}.${frac}` : w;
}

function parsePercToNative(input: string): bigint {
  const parts = input.split(".");
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").padEnd(6, "0").slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(frac);
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export const TradeForm: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { connected } = useWallet();
  const userAccount = useUserAccount();
  const { trade, loading, error } = useTrade(slabAddress);
  const { params } = useEngineState();
  const { accounts, config: mktConfig } = useSlabState();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const { priceUsd } = useLivePrice();
  const symbol = tokenMeta?.symbol ?? "Token";

  const [direction, setDirection] = useState<"long" | "short">("long");
  const [marginInput, setMarginInput] = useState("");
  const [leverage, setLeverage] = useState(1);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [tradePhase, setTradePhase] = useState<"idle" | "submitting" | "confirming">("idle");
  const [humanError, setHumanError] = useState<string | null>(null);

  const lpIdx = useMemo(() => {
    const lp = accounts.find(({ account }) => account.kind === AccountKind.LP);
    return lp?.idx ?? 0;
  }, [accounts]);

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

  const marginNative = marginInput ? parsePercToNative(marginInput) : 0n;
  const positionSize = marginNative * BigInt(leverage);
  const exceedsMargin = marginNative > 0n && marginNative > capital;

  const setMarginPercent = useCallback(
    (pct: number) => {
      if (capital <= 0n) return;
      const amount = (capital * BigInt(pct)) / 100n;
      setMarginInput(formatPerc(amount));
    },
    [capital]
  );

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
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6 text-center shadow-sm">
        <p className="text-[#8B95B0]">Connect your wallet to trade</p>
      </div>
    );
  }

  if (!userAccount) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6 text-center shadow-sm">
        <p className="text-[#8B95B0]">
          No trading account yet. Use the <strong className="text-[#F0F4FF]">Create Account</strong> button in the Deposit panel on the right to get started.
        </p>
      </div>
    );
  }

  if (hasPosition) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6 shadow-sm">
        <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[#8B95B0]">
          Trade
        </h3>
        <div className="rounded-lg border border-amber-900/50 bg-amber-900/20 p-4 text-sm text-amber-300">
          <p className="font-medium">Position open</p>
          <p className="mt-1 text-xs text-amber-400/70">
            You have an open {existingPosition > 0n ? "LONG" : "SHORT"} of{" "}
            {formatPerc(abs(existingPosition))} {symbol}.
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
      setHumanError(humanizeError(msg));
      setTradePhase("idle");
    }
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6 shadow-sm">
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[#8B95B0]">
        Trade
      </h3>

      {/* Direction toggle */}
      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setDirection("long")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-all duration-150 ${
            direction === "long"
              ? "bg-[#00FFB2] text-[#06080d] shadow-lg shadow-[#00FFB2]/20"
              : "bg-white/5 text-[#8B95B0] hover:bg-white/[0.06] hover:text-[#F0F4FF]"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setDirection("short")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-all duration-150 ${
            direction === "short"
              ? "bg-[#FF4466] text-white shadow-lg shadow-[#FF4466]/20"
              : "bg-white/5 text-[#8B95B0] hover:bg-white/[0.06] hover:text-[#F0F4FF]"
          }`}
        >
          Short
        </button>
      </div>

      {/* Margin input */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-[#8B95B0]">Margin ({symbol})<InfoIcon tooltip="The amount of collateral you're putting up for this trade. If your position loses more than your margin, you get liquidated." /></label>
          <span className="text-xs text-[#8B95B0]">
            Balance: <span className="text-[#8B95B0]">{formatPerc(capital)}</span>
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
            className={`w-full rounded-lg border px-3 py-2.5 pr-14 text-[#F0F4FF] placeholder-[#3D4563] focus:outline-none focus:ring-2 focus-visible:ring-2 ${
              exceedsMargin
                ? "border-[#FF4466]/50 bg-red-900/20 focus:border-[#FF4466] focus:ring-[#FF4466]/30"
                : "border-white/[0.06] bg-white/[0.04] focus:border-[#7B61FF] focus:ring-[#7B61FF]/30"
            }`}
          />
          <button
            onClick={() => {
              if (capital > 0n) setMarginInput(formatPerc(capital));
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-[#7B61FF]/20 px-2 py-0.5 text-xs font-medium text-[#7B61FF] transition-colors hover:bg-[#7B61FF]/30"
          >
            Max
          </button>
        </div>
        {exceedsMargin && (
          <p className="mt-1 text-xs text-[#FF4466]">
            Exceeds balance ({formatPerc(capital)} {symbol})
          </p>
        )}
      </div>

      {/* Margin percentage row */}
      <div className="mb-4 flex gap-1.5">
        {MARGIN_PRESETS.map((pct) => (
          <button
            key={pct}
            onClick={() => setMarginPercent(pct)}
            className="flex-1 rounded-md bg-white/5 py-1.5 text-xs font-medium text-[#8B95B0] transition-colors hover:bg-white/[0.06] hover:text-[#8B95B0] focus-visible:ring-2 focus-visible:ring-[#7B61FF]/30"
          >
            {pct}%
          </button>
        ))}
      </div>

      {/* Leverage slider + presets */}
      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-[#8B95B0]">Leverage<InfoIcon tooltip="Multiplies your position size. 5x leverage means 5x the profit but also 5x the loss. Higher leverage = higher risk of liquidation." /></label>
          <span className="text-xs font-medium text-[#F0F4FF]">{leverage}x</span>
        </div>
        <input
          type="range"
          min={1}
          max={maxLeverage}
          step={1}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
          className="mb-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/5 accent-[#7B61FF] [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#7B61FF] [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-[#7B61FF]/30"
        />
        <div className="flex gap-1.5">
          {availableLeverage.map((l) => (
            <button
              key={l}
              onClick={() => setLeverage(l)}
              className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-all duration-150 focus-visible:ring-2 focus-visible:ring-[#7B61FF]/30 ${
                leverage === l
                  ? "bg-[#7B61FF] text-white shadow-sm shadow-[#7B61FF]/20"
                  : "bg-white/5 text-[#8B95B0] hover:bg-white/[0.06]"
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
        disabled={tradePhase !== "idle" || loading || !marginInput || positionSize <= 0n || exceedsMargin}
        className={`w-full rounded-lg py-3 text-sm font-medium text-white transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0c14] ${
          direction === "long"
            ? "bg-[#00FFB2] hover:bg-[#00e0a0] hover:shadow-lg hover:shadow-[#00FFB2]/20 focus-visible:ring-[#00FFB2]"
            : "bg-[#FF4466] hover:bg-[#FF4466] hover:shadow-lg hover:shadow-[#FF4466]/20 focus-visible:ring-[#FF4466]"
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
      <p className="mt-1.5 text-center text-[10px] text-[#3D4563]">
        Press Enter to submit
      </p>

      {humanError && (
        <div className="mt-2 rounded-lg border border-[#FF4466]/20 bg-[#FF4466]/10 px-3 py-2">
          <p className="text-xs text-[#FF4466]">{humanError}</p>
        </div>
      )}

      {lastSig && (
        <p className="mt-2 text-xs text-[#8B95B0]">
          Tx:{" "}
          <a
            href={`${explorerTxUrl(lastSig)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#7B61FF] hover:underline"
          >
            {lastSig.slice(0, 16)}...
          </a>
        </p>
      )}
    </div>
  );
};
