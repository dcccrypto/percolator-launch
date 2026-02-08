"use client";

import { FC, useState, useMemo, useCallback, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTrade } from "@/hooks/useTrade";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useLivePrice } from "@/hooks/useLivePrice";
import { AccountKind } from "@percolator/core";

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

  // Estimated fee
  const estFee = positionSize > 0n ? (positionSize * tradingFeeBps) / 10000n : 0n;

  // Estimated liquidation price
  const estLiqPrice = useMemo(() => {
    if (!priceUsd || leverage <= 0) return null;
    const entry = priceUsd;
    const mmBps = Number(maintenanceMarginBps);
    if (direction === "long") {
      return entry * (1 - 1 / leverage + mmBps / 10000 / leverage);
    } else {
      return entry * (1 + 1 / leverage - mmBps / 10000 / leverage);
    }
  }, [priceUsd, leverage, maintenanceMarginBps, direction]);

  // Notional USD value
  const notionalUsd = useMemo(() => {
    if (!priceUsd || positionSize <= 0n) return null;
    return (Number(positionSize) / 1e6) * priceUsd;
  }, [priceUsd, positionSize]);

  const setMarginPercent = useCallback(
    (pct: number) => {
      if (capital <= 0n) return;
      const amount = (capital * BigInt(pct)) / 100n;
      setMarginInput((amount / 1_000_000n).toString());
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
      <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-6 text-center shadow-sm">
        <p className="text-[#71717a]">Connect your wallet to trade</p>
      </div>
    );
  }

  if (!userAccount) {
    return (
      <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-6 text-center shadow-sm">
        <p className="text-[#71717a]">
          No account found. Go to Dashboard to create one.
        </p>
      </div>
    );
  }

  if (hasPosition) {
    return (
      <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-6 shadow-sm">
        <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[#71717a]">
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
    try {
      const size = direction === "short" ? -positionSize : positionSize;
      const sig = await trade({
        lpIdx,
        userIdx: userAccount.idx,
        size,
      });
      setLastSig(sig ?? null);
      setMarginInput("");
    } catch {
      // error is set by hook
    }
  }

  return (
    <div className="rounded-xl border border-[#1e1e2e] bg-[#12121a] p-6 shadow-sm">
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-[#71717a]">
        Trade
      </h3>

      {/* Direction toggle */}
      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setDirection("long")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-all duration-150 ${
            direction === "long"
              ? "bg-emerald-600 text-white shadow-lg shadow-emerald-600/20"
              : "bg-[#1a1a2e] text-[#71717a] hover:bg-[#1e1e2e] hover:text-[#a1a1aa]"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setDirection("short")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-all duration-150 ${
            direction === "short"
              ? "bg-red-600 text-white shadow-lg shadow-red-600/20"
              : "bg-[#1a1a2e] text-[#71717a] hover:bg-[#1e1e2e] hover:text-[#a1a1aa]"
          }`}
        >
          Short
        </button>
      </div>

      {/* Margin input */}
      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-[#71717a]">Margin ({symbol})</label>
          <span className="text-xs text-[#71717a]">
            Balance: <span className="text-[#a1a1aa]">{formatPerc(capital)}</span>
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
            className={`w-full rounded-lg border px-3 py-2.5 pr-14 text-[#e4e4e7] placeholder-[#52525b] focus:outline-none focus:ring-2 focus-visible:ring-2 ${
              exceedsMargin
                ? "border-red-500/50 bg-red-900/20 focus:border-red-500 focus:ring-red-500/30"
                : "border-[#1e1e2e] bg-[#1a1a28] focus:border-blue-500 focus:ring-blue-500/30"
            }`}
          />
          <button
            onClick={() => {
              if (capital > 0n) setMarginInput((capital / 1_000_000n).toString());
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-blue-600/20 px-2 py-0.5 text-xs font-medium text-blue-400 transition-colors hover:bg-blue-600/30"
          >
            Max
          </button>
        </div>
        {exceedsMargin && (
          <p className="mt-1 text-xs text-red-400">
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
            className="flex-1 rounded-md bg-[#1a1a2e] py-1.5 text-xs font-medium text-[#71717a] transition-colors hover:bg-[#1e1e2e] hover:text-[#a1a1aa] focus-visible:ring-2 focus-visible:ring-blue-500/30"
          >
            {pct}%
          </button>
        ))}
      </div>

      {/* Leverage slider + presets */}
      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-[#71717a]">Leverage</label>
          <span className="text-xs font-medium text-[#e4e4e7]">{leverage}x</span>
        </div>
        <input
          type="range"
          min={1}
          max={maxLeverage}
          step={1}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
          className="mb-2 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[#1a1a2e] accent-blue-500 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-blue-500/30"
        />
        <div className="flex gap-1.5">
          {availableLeverage.map((l) => (
            <button
              key={l}
              onClick={() => setLeverage(l)}
              className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-all duration-150 focus-visible:ring-2 focus-visible:ring-blue-500/30 ${
                leverage === l
                  ? "bg-blue-600 text-white shadow-sm shadow-blue-600/20"
                  : "bg-[#1a1a2e] text-[#71717a] hover:bg-[#1e1e2e]"
              }`}
            >
              {l}x
            </button>
          ))}
        </div>
      </div>

      {/* Position summary */}
      {marginInput && marginNative > 0n && !exceedsMargin && (
        <div className="mb-4 space-y-1.5 rounded-lg bg-[#1a1a28] p-3 text-xs text-[#71717a]">
          <div className="flex justify-between">
            <span>Position Size</span>
            <span className="font-medium text-[#e4e4e7]">
              {formatPerc(positionSize)} {symbol}
            </span>
          </div>
          {notionalUsd !== null && (
            <div className="flex justify-between">
              <span>Notional Value</span>
              <span className="font-medium text-[#e4e4e7]">
                ${notionalUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Direction</span>
            <span
              className={`font-medium ${
                direction === "long" ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {direction === "long" ? "Long" : "Short"} {leverage}x
            </span>
          </div>
          <div className="flex justify-between">
            <span>Est. Fee</span>
            <span className="font-medium text-[#a1a1aa]">
              {formatPerc(estFee)} {symbol}
            </span>
          </div>
          {estLiqPrice !== null && (
            <div className="flex justify-between">
              <span>Est. Liq. Price</span>
              <span className="font-medium text-amber-400">
                ${estLiqPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleTrade}
        disabled={loading || !marginInput || positionSize <= 0n || exceedsMargin}
        className={`w-full rounded-lg py-3 text-sm font-medium text-white transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#12121a] ${
          direction === "long"
            ? "bg-emerald-600 hover:bg-emerald-500 hover:shadow-lg hover:shadow-emerald-600/20 focus-visible:ring-emerald-500"
            : "bg-red-600 hover:bg-red-500 hover:shadow-lg hover:shadow-red-600/20 focus-visible:ring-red-500"
        }`}
      >
        {loading
          ? "Sending..."
          : `${direction === "long" ? "Long" : "Short"} ${leverage}x`}
      </button>
      <p className="mt-1.5 text-center text-[10px] text-[#52525b]">
        Press Enter to submit
      </p>

      {error && (
        <p className="mt-2 text-xs text-red-400">{error}</p>
      )}

      {lastSig && (
        <p className="mt-2 text-xs text-[#71717a]">
          Tx:{" "}
          <a
            href={`https://explorer.solana.com/tx/${lastSig}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline"
          >
            {lastSig.slice(0, 16)}...
          </a>
        </p>
      )}
    </div>
  );
};
