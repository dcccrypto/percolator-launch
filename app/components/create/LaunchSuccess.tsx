"use client";

import { FC, useState } from "react";
import Link from "next/link";
import { LogoUpload } from "./LogoUpload";

interface LaunchSuccessProps {
  tokenSymbol: string;
  tradingFeeBps: number;
  maxLeverage: number;
  slabLabel: string;
  marketAddress: string;
  txSigs: string[];
  onDeployAnother: () => void;
}

/**
 * Success state after market launch.
 * Shows market card, address with copy, Solscan link, and CTAs.
 */
export const LaunchSuccess: FC<LaunchSuccessProps> = ({
  tokenSymbol,
  tradingFeeBps,
  maxLeverage,
  slabLabel,
  marketAddress,
  txSigs,
  onDeployAnother,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(marketAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="border border-[var(--long)]/30 bg-[var(--long)]/[0.06] p-6 text-center">
      {/* Success icon */}
      <div className="mb-4">
        <div className="inline-flex h-12 w-12 items-center justify-center border-2 border-[var(--long)]/40 bg-[var(--long)]/[0.1] text-[24px] text-[var(--long)]">
          ✓
        </div>
      </div>

      <h2 className="text-[18px] font-bold text-[var(--long)] mb-2">
        MARKET LAUNCHED
      </h2>
      <p className="text-[13px] text-[var(--text-secondary)] mb-4">
        {tokenSymbol}-PERP is live on Percolator devnet
      </p>

      {/* Market address */}
      <div className="flex items-center justify-center gap-2 mb-4">
        <code className="font-mono text-[10px] text-[var(--accent)]/80 bg-[var(--bg)] border border-[var(--border)] px-3 py-1.5 break-all">
          {marketAddress}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          className="border border-[var(--border)] px-2 py-1.5 text-[9px] font-medium text-[var(--text-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)]/30 transition-colors"
          title="Copy address"
        >
          {copied ? "✓" : "copy"}
        </button>
        <a
          href={`https://explorer.solana.com/address/${marketAddress}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="border border-[var(--border)] px-2 py-1.5 text-[9px] font-medium text-[var(--text-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)]/30 transition-colors"
          title="View on Solscan"
        >
          Explorer ↗
        </a>
      </div>

      {/* Market preview card */}
      <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.02] p-4 mb-6 inline-block text-left w-full max-w-sm mx-auto">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center border border-[var(--accent)]/30 bg-[var(--accent)]/[0.08] text-[11px] font-bold text-[var(--accent)]">
            {tokenSymbol.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <p className="text-[13px] font-bold text-white">{tokenSymbol}-PERP</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[9px] text-[var(--text-dim)]">Fee: {tradingFeeBps} bps</span>
              <span className="text-[9px] text-[var(--text-dim)]">·</span>
              <span className="text-[9px] text-[var(--text-dim)]">Leverage: {maxLeverage}x</span>
              <span className="text-[9px] text-[var(--text-dim)]">·</span>
              <span className="text-[9px] text-[var(--text-dim)]">Slab: {slabLabel}</span>
            </div>
          </div>
        </div>
      </div>

      {/* CTAs */}
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        <Link
          href={`/trade/${marketAddress}`}
          className="w-full sm:w-auto border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-8 py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all hud-btn-corners hover:bg-[var(--accent)]/[0.15]"
        >
          TRADE THIS MARKET →
        </Link>
        <button
          type="button"
          onClick={onDeployAnother}
          className="w-full sm:w-auto border border-[var(--border)] bg-transparent px-8 py-3 text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all hud-btn-corners hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
        >
          DEPLOY ANOTHER MARKET
        </button>
      </div>

      {/* Logo upload */}
      <LogoUpload slabAddress={marketAddress} />

      {/* Transaction signatures */}
      {txSigs.length > 0 && (
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text-dim)] mb-2">
            Transactions
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {txSigs.map((sig, i) => (
              <a
                key={i}
                href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[10px] text-[var(--text-dim)] hover:text-[var(--accent)] transition-colors"
              >
                Step {i + 1}: {sig.slice(0, 8)}... ↗
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
