"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePortfolio } from "@/hooks/usePortfolio";
import { formatTokenAmount, formatPriceE6 } from "@/lib/format";
import dynamic from "next/dynamic";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

function formatPnl(pnl: bigint, decimals = 6): string {
  const isNeg = pnl < 0n;
  const abs = isNeg ? -pnl : pnl;
  return `${isNeg ? "-" : "+"}${formatTokenAmount(abs, decimals)}`;
}

export default function PortfolioPage() {
  const { connected } = useWallet();
  const { positions, totalPnl, totalDeposited, loading } = usePortfolio();

  if (!connected) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-12">
        <h1 className="mb-2 text-3xl font-bold text-white">Portfolio</h1>
        <p className="mb-8 text-slate-400">View all your positions across markets.</p>
        <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-16 text-center">
          <p className="mb-4 text-slate-400">Connect your wallet to view positions</p>
          <WalletMultiButton />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-12">
      <h1 className="mb-2 text-3xl font-bold text-white">Portfolio</h1>
      <p className="mb-8 text-slate-400">All your positions across Percolator markets.</p>

      {/* Aggregate Stats */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-[#1e2433] bg-[#111318] p-5">
          <p className="text-xs text-slate-500">Total Deposited</p>
          <p className="mt-1 text-xl font-bold text-white">
            {loading ? "..." : formatTokenAmount(totalDeposited)}
          </p>
        </div>
        <div className="rounded-xl border border-[#1e2433] bg-[#111318] p-5">
          <p className="text-xs text-slate-500">Total PnL</p>
          <p className={`mt-1 text-xl font-bold ${totalPnl >= 0n ? "text-emerald-400" : "text-red-400"}`}>
            {loading ? "..." : formatPnl(totalPnl)}
          </p>
        </div>
        <div className="rounded-xl border border-[#1e2433] bg-[#111318] p-5">
          <p className="text-xs text-slate-500">Active Positions</p>
          <p className="mt-1 text-xl font-bold text-white">
            {loading ? "..." : positions.length}
          </p>
        </div>
      </div>

      {/* Positions */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl border border-[#1e2433] bg-[#111318]" />
          ))}
        </div>
      ) : positions.length === 0 ? (
        <div className="rounded-2xl border border-[#1e2433] bg-[#111318] p-16 text-center">
          <div className="mb-4 text-5xl">📊</div>
          <h3 className="mb-2 text-xl font-semibold text-white">No positions yet</h3>
          <p className="mb-6 text-slate-400">Browse markets to start trading.</p>
          <Link
            href="/markets"
            className="inline-block rounded-xl bg-emerald-500 px-8 py-3 font-semibold text-white hover:bg-emerald-400"
          >
            Browse Markets
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {positions.map((pos, i) => {
            const side = pos.account.positionSize > 0n ? "Long" : pos.account.positionSize < 0n ? "Short" : "Flat";
            const sizeAbs = pos.account.positionSize < 0n ? -pos.account.positionSize : pos.account.positionSize;
            const pnlPositive = pos.account.pnl >= 0n;

            return (
              <Link
                key={`${pos.slabAddress}-${i}`}
                href={`/trade/${pos.slabAddress}`}
                className="block rounded-xl border border-[#1e2433] bg-[#111318] p-5 transition-colors hover:bg-[#1a1d24]"
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">
                        {pos.slabAddress.slice(0, 8)}...
                      </span>
                      <span className={`rounded px-2 py-0.5 text-xs font-bold ${
                        side === "Long"
                          ? "bg-emerald-500/10 text-emerald-400"
                          : side === "Short"
                          ? "bg-red-500/10 text-red-400"
                          : "bg-slate-500/10 text-slate-400"
                      }`}>
                        {side}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-6 text-sm">
                    <div>
                      <p className="text-xs text-slate-500">Size</p>
                      <p className="font-mono text-white">{formatTokenAmount(sizeAbs)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Entry</p>
                      <p className="font-mono text-white">{formatPriceE6(pos.account.entryPrice)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Capital</p>
                      <p className="font-mono text-white">{formatTokenAmount(pos.account.capital)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">PnL</p>
                      <p className={`font-mono ${pnlPositive ? "text-emerald-400" : "text-red-400"}`}>
                        {formatPnl(pos.account.pnl)}
                      </p>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
