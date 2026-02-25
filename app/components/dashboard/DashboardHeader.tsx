"use client";

import { usePortfolio } from "@/hooks/usePortfolio";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { formatTokenAmount } from "@/lib/format";
import { isMockMode } from "@/lib/mock-mode";
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
  const mockMode = isMockMode();
  const portfolio = usePortfolio();

  const address = publicKey?.toBase58() ?? (mockMode ? "7xBk...Rp3q" : "");
  const totalValue = portfolio.totalValue ?? 0n;
  const totalPnl = portfolio.totalUnrealizedPnl ?? 0n;
  const positionCount = portfolio.positions?.length ?? 0;

  // Mock portfolio value for demo
  const displayValue = totalValue > 0n
    ? formatTokenAmount(totalValue)
    : mockMode ? "$12,450.32" : "$0.00";

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
          <p className="text-[8px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
            Portfolio Value
          </p>
          <p
            className="text-sm font-bold text-white"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            {displayValue}
            {(totalPnl !== 0n || mockMode) && (
              <span
                className={`ml-2 text-[10px] ${pnlPositive ? "text-[var(--long)]" : "text-[var(--short)]"}`}
              >
                {pnlPositive ? "▲" : "▼"} {mockMode ? "+2.3%" : `${((Number(totalPnl) / Math.max(Number(totalValue), 1)) * 100).toFixed(1)}%`}
              </span>
            )}
          </p>
        </div>

        <div className="h-6 w-px bg-[var(--border)]" />

        <div className="text-right">
          <p className="text-[8px] font-medium uppercase tracking-[0.2em] text-[var(--text-dim)]">
            Active Positions
          </p>
          <p
            className="text-sm font-bold text-white"
            style={{ fontFamily: "var(--font-jetbrains-mono)" }}
          >
            {mockMode && positionCount === 0 ? "3" : positionCount}
          </p>
        </div>
      </div>
    </div>
  );
}
