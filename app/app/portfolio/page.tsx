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
      <div className="terminal-grid min-h-[calc(100vh-48px)] gsap-fade">
        <div className="mx-auto max-w-[1800px] px-3 py-6 lg:px-4">
          <h1 className="mb-1 text-2xl font-bold text-white">Portfolio</h1>
          <p className="mb-6 text-sm text-[#71717a]">View all your positions across markets</p>
          <div className="rounded-[4px] bg-[#111113] p-16 text-center border border-[#1a1a1f]">
            <p className="mb-4 text-sm text-[#71717a]">Connect your wallet to view positions</p>
            <WalletMultiButton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-grid min-h-[calc(100vh-48px)] gsap-fade">
      <div className="mx-auto max-w-[1800px] px-3 py-6 lg:px-4">
        <h1 className="mb-1 text-2xl font-bold text-white">Portfolio</h1>
        <p className="mb-6 text-sm text-[#71717a]">All positions across Percolator markets</p>

        {/* Summary cards */}
        <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-[4px] bg-[#111113] p-4 border border-[#1a1a1f]">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[#52525b]">Total Deposited</p>
            <p className="mt-1 data-cell text-xl font-bold text-white">
              {loading ? "…" : formatTokenAmount(totalDeposited)}
            </p>
          </div>
          <div className="rounded-[4px] bg-[#111113] p-4 border border-[#1a1a1f]">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[#52525b]">Total PnL</p>
            <p className={`mt-1 data-cell text-xl font-bold ${totalPnl >= 0n ? "text-[#00e68a]" : "text-[#ff4d6a]"}`}>
              {loading ? "…" : formatPnl(totalPnl)}
            </p>
          </div>
          <div className="rounded-[4px] bg-[#111113] p-4 border border-[#1a1a1f]">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[#52525b]">Active Positions</p>
            <p className="mt-1 data-cell text-xl font-bold text-white">
              {loading ? "…" : positions.length}
            </p>
          </div>
        </div>

        {/* Positions */}
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-[4px] bg-[#111113] border border-[#1a1a1f]" />
            ))}
          </div>
        ) : positions.length === 0 ? (
          <div className="rounded-[4px] bg-[#111113] p-16 text-center border border-[#1a1a1f]">
            <div className="mb-3 text-3xl text-[#1a1d2a]">📊</div>
            <h3 className="mb-1 text-lg font-semibold text-white">No positions yet</h3>
            <p className="mb-4 text-sm text-[#71717a]">Browse markets to start trading.</p>
            <Link href="/markets" className="inline-block rounded-[4px] bg-[#00FFB2] px-6 py-2.5 text-sm font-bold text-[#080a0f]">
              Browse Markets
            </Link>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[4px] border border-[#1a1a1f]">
            {/* Header */}
            <div className="grid grid-cols-6 gap-4 bg-[#09090b] px-4 py-2.5 text-[9px] font-medium uppercase tracking-wider text-[#52525b]">
              <div>Market</div>
              <div className="text-center">Side</div>
              <div className="text-right">Size</div>
              <div className="text-right">Entry</div>
              <div className="text-right">Capital</div>
              <div className="text-right">PnL</div>
            </div>

            {positions.map((pos, i) => {
              const side = pos.account.positionSize > 0n ? "Long" : pos.account.positionSize < 0n ? "Short" : "Flat";
              const sizeAbs = pos.account.positionSize < 0n ? -pos.account.positionSize : pos.account.positionSize;
              const pnlPositive = pos.account.pnl >= 0n;

              return (
                <Link
                  key={`${pos.slabAddress}-${i}`}
                  href={`/trade/${pos.slabAddress}`}
                  className={`grid grid-cols-6 gap-4 px-4 py-3 transition-all hover:bg-[#131620] ${
                    i > 0 ? "border-t border-white/[0.06]" : ""
                  } bg-[#111113]`}
                >
                  <div>
                    <span className="data-cell text-sm font-semibold text-white">
                      {pos.slabAddress.slice(0, 8)}…
                    </span>
                  </div>
                  <div className="text-center">
                    <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                      side === "Long"
                        ? "bg-[#00e68a]/10 text-[#00e68a]"
                        : side === "Short"
                        ? "bg-[#ff4d6a]/10 text-[#ff4d6a]"
                        : "bg-white/[0.06] text-[#71717a]"
                    }`}>
                      {side.toUpperCase()}
                    </span>
                  </div>
                  <div className="data-cell text-right text-sm text-white">{formatTokenAmount(sizeAbs)}</div>
                  <div className="data-cell text-right text-sm text-[#7a8194]">{formatPriceE6(pos.account.entryPrice)}</div>
                  <div className="data-cell text-right text-sm text-[#7a8194]">{formatTokenAmount(pos.account.capital)}</div>
                  <div className={`data-cell text-right text-sm font-medium ${pnlPositive ? "text-[#00e68a]" : "text-[#ff4d6a]"}`}>
                    {formatPnl(pos.account.pnl)}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
