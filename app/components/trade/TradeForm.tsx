"use client";

import { FC, useState, useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTrade } from "@/hooks/useTrade";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { AccountKind } from "@percolator/core";

const LEVERAGE_OPTIONS = [1, 2, 3, 5, 10];

function formatPerc(native: bigint): string {
  return (native / 1_000_000n).toLocaleString();
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

export const TradeForm: FC = () => {
  const { connected } = useWallet();
  const userAccount = useUserAccount();
  const { trade, loading, error } = useTrade();
  const { params } = useEngineState();
  const { accounts, config: mktConfig } = useSlabState();
  const tokenMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
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
  const maxLeverage = Number(10000n / initialMarginBps);

  const availableLeverage = LEVERAGE_OPTIONS.filter((l) => l <= maxLeverage);
  if (availableLeverage.length === 0 || availableLeverage[availableLeverage.length - 1] < maxLeverage) {
    availableLeverage.push(maxLeverage);
  }

  const capital = userAccount ? userAccount.account.capital : 0n;
  const existingPosition = userAccount ? userAccount.account.positionSize : 0n;
  const hasPosition = existingPosition !== 0n;

  const marginNative = marginInput ? parsePercToNative(marginInput) : 0n;
  const positionSize = marginNative * BigInt(leverage);

  const exceedsMargin = marginNative > 0n && marginNative > capital;

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
          className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors ${
            direction === "long"
              ? "bg-emerald-600 text-white"
              : "bg-[#1a1a2e] text-[#71717a] hover:bg-[#1e1e2e]"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setDirection("short")}
          className={`flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors ${
            direction === "short"
              ? "bg-red-600 text-white"
              : "bg-[#1a1a2e] text-[#71717a] hover:bg-[#1e1e2e]"
          }`}
        >
          Short
        </button>
      </div>

      {/* Margin input */}
      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-[#71717a]">Margin ({symbol})</label>
          <button
            onClick={() => {
              if (capital > 0n) setMarginInput((capital / 1_000_000n).toString());
            }}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            Balance: {formatPerc(capital)}
          </button>
        </div>
        <input
          type="text"
          value={marginInput}
          onChange={(e) => setMarginInput(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="100000"
          className={`w-full rounded-lg border px-3 py-2.5 text-[#e4e4e7] placeholder-[#52525b] focus:outline-none focus:ring-1 ${
            exceedsMargin
              ? "border-red-500/50 bg-red-900/20 focus:border-red-500 focus:ring-red-500"
              : "border-[#1e1e2e] bg-[#1a1a28] focus:border-blue-500 focus:ring-blue-500"
          }`}
        />
        {exceedsMargin && (
          <p className="mt-1 text-xs text-red-400">
            Exceeds balance ({formatPerc(capital)} {symbol})
          </p>
        )}
      </div>

      {/* Leverage selector */}
      <div className="mb-4">
        <label className="mb-1 block text-xs text-[#71717a]">Leverage</label>
        <div className="flex gap-1.5">
          {availableLeverage.map((l) => (
            <button
              key={l}
              onClick={() => setLeverage(l)}
              className={`flex-1 rounded-lg py-2 text-xs font-medium transition-colors ${
                leverage === l
                  ? "bg-blue-600 text-white"
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
        <div className="mb-4 rounded-lg bg-[#1a1a28] p-3 text-xs text-[#71717a]">
          <div className="flex justify-between">
            <span>Position Size</span>
            <span className="font-medium text-[#e4e4e7]">
              {formatPerc(positionSize)} {symbol}
            </span>
          </div>
          <div className="mt-1 flex justify-between">
            <span>Direction</span>
            <span
              className={`font-medium ${
                direction === "long" ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {direction === "long" ? "Long" : "Short"} {leverage}x
            </span>
          </div>
        </div>
      )}

      {/* Submit */}
      <button
        onClick={handleTrade}
        disabled={loading || !marginInput || positionSize <= 0n || exceedsMargin}
        className={`w-full rounded-lg py-3 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          direction === "long"
            ? "bg-emerald-600 hover:bg-emerald-700"
            : "bg-red-600 hover:bg-red-700"
        }`}
      >
        {loading
          ? "Sending..."
          : `${direction === "long" ? "Long" : "Short"} ${leverage}x`}
      </button>

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
