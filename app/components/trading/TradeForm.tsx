"use client";

import { FC, useState, useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useTrade } from "@/hooks/useTrade";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useEngineState } from "@/hooks/useEngineState";
import { useSlabState } from "@/components/providers/SlabProvider";
import { AccountKind } from "@percolator/core";

const LEVERAGE_OPTIONS = [1, 2, 3, 5, 10];

function formatPerc(native: bigint): string {
  const whole = native / 1_000_000n;
  const frac = native % 1_000_000n;
  if (frac === 0n) return whole.toLocaleString();
  return `${whole.toLocaleString()}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

function parsePercToNative(input: string): bigint {
  const parts = input.split(".");
  const whole = parts[0] || "0";
  const frac = (parts[1] || "").padEnd(6, "0").slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(frac);
}

export const TradeForm: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const { connected } = useWallet();
  const userAccount = useUserAccount();
  const { trade, loading, error } = useTrade(slabAddress);
  const { params } = useEngineState();
  const { accounts } = useSlabState();

  const [direction, setDirection] = useState<"long" | "short">("long");
  const [marginInput, setMarginInput] = useState("");
  const [leverage, setLeverage] = useState(2);
  const [lastSig, setLastSig] = useState<string | null>(null);

  const lpIdx = useMemo(() => {
    const lp = accounts.find(({ account }) => account.kind === AccountKind.LP);
    return lp?.idx ?? 0;
  }, [accounts]);

  const maxLeverage = params ? Number(10000n / params.initialMarginBps) : 10;
  const availableLeverage = LEVERAGE_OPTIONS.filter((l) => l <= maxLeverage);
  if (availableLeverage.length === 0 || availableLeverage[availableLeverage.length - 1] < maxLeverage) {
    availableLeverage.push(maxLeverage);
  }

  const balance = userAccount ? userAccount.account.capital : 0n;
  const marginNative = marginInput ? parsePercToNative(marginInput) : 0n;
  const positionSize = marginNative * BigInt(leverage);

  if (!connected) {
    return (
      <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-6 text-center">
        <p className="text-slate-400">Connect your wallet to trade</p>
      </div>
    );
  }

  if (!userAccount) {
    return (
      <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-6 text-center">
        <p className="text-slate-400">No account found. Create one below to start trading.</p>
      </div>
    );
  }

  async function handleTrade() {
    if (!marginInput || !userAccount || positionSize <= 0n) return;
    try {
      const size = direction === "short" ? -positionSize : positionSize;
      const sig = await trade({ lpIdx, userIdx: userAccount.idx, size });
      setLastSig(sig ?? null);
      setMarginInput("");
    } catch { /* error set by hook */ }
  }

  return (
    <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-6">
      <h3 className="mb-4 text-sm font-medium uppercase tracking-wider text-slate-500">Trade</h3>

      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setDirection("long")}
          className={`flex-1 rounded-xl py-2.5 text-sm font-medium transition-colors ${
            direction === "long" ? "bg-emerald-500 text-white" : "bg-slate-800 text-slate-400 hover:bg-slate-700"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setDirection("short")}
          className={`flex-1 rounded-xl py-2.5 text-sm font-medium transition-colors ${
            direction === "short" ? "bg-red-500 text-white" : "bg-slate-800 text-slate-400 hover:bg-slate-700"
          }`}
        >
          Short
        </button>
      </div>

      <div className="mb-4">
        <div className="mb-1 flex items-center justify-between">
          <label className="text-xs text-slate-500">Margin</label>
          <button
            onClick={() => { if (balance > 0n) setMarginInput(formatPerc(balance)); }}
            className="text-xs text-emerald-400 hover:text-emerald-300"
          >
            Balance: {formatPerc(balance)}
          </button>
        </div>
        <input
          type="text"
          value={marginInput}
          onChange={(e) => setMarginInput(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="100000"
          className="w-full rounded-xl border border-[#1e2433] bg-[#0a0b0f] px-3 py-2.5 text-white placeholder-slate-600 focus:border-emerald-500 focus:outline-none"
        />
      </div>

      <div className="mb-4">
        <label className="mb-1 block text-xs text-slate-500">Leverage</label>
        <div className="flex gap-1.5">
          {availableLeverage.map((l) => (
            <button
              key={l}
              onClick={() => setLeverage(l)}
              className={`flex-1 rounded-lg py-2 text-xs font-medium transition-colors ${
                leverage === l ? "bg-emerald-500 text-white" : "bg-slate-800 text-slate-400 hover:bg-slate-700"
              }`}
            >
              {l}x
            </button>
          ))}
        </div>
      </div>

      {marginInput && marginNative > 0n && (
        <div className="mb-4 rounded-xl bg-[#0a0b0f] p-3 text-xs text-slate-400">
          <div className="flex justify-between">
            <span>Position Size</span>
            <span className="font-medium text-white">{formatPerc(positionSize)}</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span>Direction</span>
            <span className={`font-medium ${direction === "long" ? "text-emerald-400" : "text-red-400"}`}>
              {direction === "long" ? "Long" : "Short"} {leverage}x
            </span>
          </div>
        </div>
      )}

      <button
        onClick={handleTrade}
        disabled={loading || !marginInput || positionSize <= 0n}
        className={`w-full rounded-xl py-3 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          direction === "long" ? "bg-emerald-500 hover:bg-emerald-400" : "bg-red-500 hover:bg-red-400"
        }`}
      >
        {loading ? "Sending..." : `${direction === "long" ? "Long" : "Short"} ${leverage}x`}
      </button>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {lastSig && (
        <p className="mt-2 text-xs text-slate-500">
          Tx:{" "}
          <a href={`https://explorer.solana.com/tx/${lastSig}${typeof window !== "undefined" && localStorage.getItem("percolator_network") === "mainnet" ? "" : "?cluster=devnet"}`} target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">
            {lastSig.slice(0, 16)}...
          </a>
        </p>
      )}
    </div>
  );
};
