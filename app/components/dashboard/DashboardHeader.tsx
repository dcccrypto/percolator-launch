"use client";

import { usePortfolio, isOpenPosition } from "@/hooks/usePortfolio";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { formatTokenAmount } from "@/lib/format";
import { useState } from "react";

function CopyableAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const short = `${address.slice(0, 4)}...${address.slice(-4)}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 rounded-sm border border-[var(--border)] bg-[var(--bg)] px-2.5 py-1 text-[11px] transition-all hover:border-[var(--accent)]/30"
      title="Click to copy full address"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--long)]" />
      <span className="text-[var(--text-secondary)]" style={{ fontFamily: "var(--font-jetbrains-mono)" }}>
        {copied ? "Copied!" : short}
      </span>
    </button>
  );
}

export function DashboardHeader() {
  const { publicKey } = useWalletCompat();
  const portfolio = usePortfolio();

  const address = publicKey?.toBase58() ?? "";
  const totalValue = portfolio.totalValue ?? 0n;
  const totalPnl = portfolio.totalUnrealizedPnl ?? 0n;
  // Count OPEN positions only — a closed (size-0 "Flat") position still has a
  // portfolio account and would otherwise inflate the "Active Positions" stat.
  const positionCount = (portfolio.positions ?? []).filter(isOpenPosition).length;

  const displayValue = totalValue > 0n
    ? formatTokenAmount(totalValue)
    : "$0.00";

  const pnlPositive = totalPnl >= 0n;

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border border-[var(--border)] bg-[var(--bg)] px-5 py-3">
      {/* Left: Wallet */}
      <div className="flex items-center gap-4">
        {address && <CopyableAddress address={address} />}
      </div>

      {/* Right: Stats */}
      <div className="flex flex-wrap items-center gap-6">
        <div className="text-right">
          <p className="text-[8px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
            Portfolio Value
          </p>
          <p
            className="text-sm font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            {displayValue}
            {totalPnl !== 0n && (
              <span
                className={`ml-2 text-[10px] ${pnlPositive ? "text-[var(--long)]" : "text-[var(--short)]"}`}
              >
                {pnlPositive ? "▲" : "▼"} {`${((Number(totalPnl) / Math.max(Number(totalValue), 1)) * 100).toFixed(1)}%`}
              </span>
            )}
          </p>
        </div>

        <div className="h-6 w-px bg-[var(--border)]" />

        <div className="text-right">
          <p className="text-[8px] font-medium uppercase tracking-[0.2em] text-[var(--text-secondary)]">
            Active Positions
          </p>
          <p
            className="text-sm font-bold text-[var(--text)]"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            {positionCount}
          </p>
        </div>
      </div>
    </div>
  );
}
