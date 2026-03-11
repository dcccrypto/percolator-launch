"use client";

import { FC, useState } from "react";
import { useParams } from "next/navigation";
import { useKeeperFund } from "@/hooks/useKeeperFund";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

function formatSol(lamports: bigint): string {
  const sol = Number(lamports) / LAMPORTS_PER_SOL;
  if (sol >= 1) return sol.toFixed(4);
  if (sol >= 0.001) return sol.toFixed(6);
  return sol.toFixed(9);
}

/**
 * PERC-623: Keeper Fund Card
 *
 * Shows keeper fund balance, reward rate, and estimated cranks remaining.
 * Market creators (admin) get a "Top Up" button.
 */
export const KeeperFundCard: FC = () => {
  const params = useParams();
  const slabAddress = params?.slab as string | undefined;
  const { fund, loading, error, isAdmin, topUp, topUpPending } = useKeeperFund(slabAddress);
  const [topUpAmount, setTopUpAmount] = useState("0.01");
  const [topUpError, setTopUpError] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="rounded-sm border border-[var(--border)] bg-[var(--panel-bg)] p-4">
        <p className="text-sm text-[var(--text-muted)]">Loading keeper fund...</p>
      </div>
    );
  }

  if (!fund) {
    // No keeper fund PDA — market may predate PERC-623
    return null;
  }

  const isLow = fund.estimatedCranksRemaining < 100;
  const isDepleted = fund.balance === 0n;
  const borderColor = isDepleted
    ? "border-red-500/40"
    : isLow
    ? "border-yellow-500/30"
    : "border-[var(--border)]";
  const bgColor = isDepleted
    ? "bg-red-500/5"
    : isLow
    ? "bg-yellow-500/5"
    : "bg-[var(--panel-bg)]";

  const handleTopUp = async () => {
    setTopUpError(null);
    setLastSig(null);
    try {
      const lamports = BigInt(Math.round(parseFloat(topUpAmount) * LAMPORTS_PER_SOL));
      if (lamports <= 0n) throw new Error("Amount must be > 0");
      const sig = await topUp(lamports);
      setLastSig(sig ?? null);
    } catch (e) {
      setTopUpError((e as Error).message);
    }
  };

  return (
    <div className={`rounded-sm border ${borderColor} ${bgColor} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium uppercase tracking-wider text-[var(--text-secondary)]">
          Keeper Fund
        </h3>
        {isDepleted && (
          <span className="text-xs font-semibold text-red-400 bg-red-500/10 px-2 py-0.5 rounded">
            DEPLETED
          </span>
        )}
        {isLow && !isDepleted && (
          <span className="text-xs font-semibold text-yellow-400 bg-yellow-500/10 px-2 py-0.5 rounded">
            LOW
          </span>
        )}
        {fund.depletedPause && (
          <span className="text-xs font-semibold text-red-400 bg-red-500/10 px-2 py-0.5 rounded ml-1">
            PAUSED
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <p className="text-[var(--text-muted)] text-xs">Balance</p>
          <p className="text-white font-mono font-semibold">{formatSol(fund.balance)} SOL</p>
        </div>
        <div>
          <p className="text-[var(--text-muted)] text-xs">Reward / Crank</p>
          <p className="text-white font-mono">{formatSol(fund.rewardPerCrank)} SOL</p>
        </div>
        <div>
          <p className="text-[var(--text-muted)] text-xs">Est. Cranks Left</p>
          <p className={`font-mono font-semibold ${isDepleted ? "text-red-400" : isLow ? "text-yellow-400" : "text-green-400"}`}>
            {fund.estimatedCranksRemaining === Infinity ? "∞" : fund.estimatedCranksRemaining.toLocaleString()}
          </p>
        </div>
        <div>
          <p className="text-[var(--text-muted)] text-xs">Lifetime Paid</p>
          <p className="text-white font-mono">{formatSol(fund.totalRewarded)} SOL</p>
        </div>
      </div>

      {/* Top Up section — visible to everyone but anyone can fund (permissionless) */}
      <div className="mt-4 pt-3 border-t border-[var(--border)]">
        <div className="flex items-center gap-2">
          <input
            type="number"
            step="0.001"
            min="0.001"
            value={topUpAmount}
            onChange={(e) => setTopUpAmount(e.target.value)}
            className="flex-1 bg-[var(--input-bg)] border border-[var(--border)] rounded px-2 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-[var(--accent)]"
            placeholder="SOL amount"
          />
          <button
            onClick={handleTopUp}
            disabled={topUpPending}
            className="px-3 py-1.5 text-sm font-medium rounded bg-[var(--accent)] text-black hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {topUpPending ? "Sending..." : "Top Up"}
          </button>
        </div>
        {topUpError && (
          <p className="mt-1 text-xs text-red-400">{topUpError}</p>
        )}
        {lastSig && (
          <p className="mt-1 text-xs text-green-400">
            ✓ Topped up!{" "}
            <a
              href={`https://explorer.solana.com/tx/${lastSig}?cluster=devnet`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              View tx
            </a>
          </p>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-400">{error}</p>
      )}
    </div>
  );
};
