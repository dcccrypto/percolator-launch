"use client";

import { FC, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogoUpload } from "./LogoUpload";
import { getNetwork } from "@/lib/config";
import { useWalletCompat } from "@/hooks/useWalletCompat";

interface LaunchSuccessProps {
  tokenSymbol: string;
  tradingFeeBps: number;
  maxLeverage: number;
  slabLabel: string;
  marketAddress: string;
  txSigs: string[];
  onDeployAnother: () => void;
  /** Original mainnet CA the user pasted */
  mainnetCA?: string;
  /** Devnet mint address (different from mainnet CA) */
  devnetMint?: string | null;
  /** Number of tokens airdropped */
  devnetAirdropAmount?: number | null;
  /** Token symbol for airdrop */
  devnetAirdropSymbol?: string | null;
  /** Error from devnet mint attempt */
  devnetMintError?: string | null;
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
  mainnetCA,
  devnetMint,
  devnetAirdropAmount,
  devnetAirdropSymbol,
  devnetMintError,
}) => {
  const [copied, setCopied] = useState(false);
  const [copiedDevnet, setCopiedDevnet] = useState(false);
  const [mintLoading, setMintLoading] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const isDevnet = getNetwork() === "devnet";
  const { publicKey } = useWalletCompat();
  const router = useRouter();

  /** PERC-475: Mint $500 worth of devnet tokens then navigate to the trade page. */
  const handleMintAndTrade = useCallback(async () => {
    if (!publicKey || !devnetMint || mintLoading) return;
    setMintLoading(true);
    setMintError(null);
    try {
      const resp = await fetch("/api/devnet-airdrop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mintAddress: devnetMint,
          walletAddress: publicKey.toBase58(),
        }),
      });
      // On 429 (rate limited) still navigate — wallet may already have tokens
      if (!resp.ok && resp.status !== 429) {
        const d = await resp.json();
        setMintError(d.error ?? "Mint failed — try again");
        setMintLoading(false);
        return;
      }
    } catch {
      // Network error — still navigate
    }
    router.push(`/trade/${marketAddress}`);
  }, [publicKey, devnetMint, mintLoading, marketAddress, router]);

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

      {/* Devnet Token Info — CA mismatch notice + airdrop confirmation + mint errors */}
      {isDevnet && (devnetMint || devnetAirdropAmount || devnetMintError) && (
        <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-4 mb-6 text-left w-full max-w-sm mx-auto space-y-3">
          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--accent)]">
            DEVNET TOKEN INFO
          </p>

          {devnetAirdropAmount && devnetAirdropSymbol && (
            <div className="flex items-center gap-2 text-[12px]">
              <span className="text-[var(--long)]">✓</span>
              <span className="text-[var(--text)]">
                Airdropped <strong>{devnetAirdropAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {devnetAirdropSymbol}</strong>{" "}
                <span className="text-[var(--text-dim)]">(~$500 worth)</span>
              </span>
            </div>
          )}

          {devnetMint && (
            <div className="space-y-1">
              <p className="text-[10px] text-[var(--text-muted)]">
                ⚠️ Devnet uses a <strong>different mint address</strong> than mainnet:
              </p>
              {mainnetCA && (
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="text-[var(--text-dim)] w-16 flex-shrink-0">Mainnet:</span>
                  <code className="font-mono text-[9px] text-[var(--text-dim)] truncate">{mainnetCA}</code>
                </div>
              )}
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-[var(--accent)] w-16 flex-shrink-0 font-medium">Devnet:</span>
                <code className="font-mono text-[9px] text-[var(--accent)] truncate flex-1">{devnetMint}</code>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(devnetMint);
                      setCopiedDevnet(true);
                      setTimeout(() => setCopiedDevnet(false), 2000);
                    } catch {}
                  }}
                  className="border border-[var(--border)] px-1.5 py-0.5 text-[8px] font-medium text-[var(--text-muted)] hover:text-[var(--accent)] hover:border-[var(--accent)]/30 transition-colors flex-shrink-0"
                >
                  {copiedDevnet ? "✓" : "copy"}
                </button>
              </div>
              <p className="text-[9px] text-[var(--text-dim)] mt-1">
                Use the devnet mint address when adding tokens to your wallet or trading.
              </p>
            </div>
          )}

          {devnetMintError && (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-[var(--short)]">✗</span>
              <span className="text-[var(--short)]">
                Token mint failed: {devnetMintError}
              </span>
            </div>
          )}

          {!devnetMint && !devnetAirdropAmount && !devnetMintError && (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-[var(--text-dim)]">⏳</span>
              <span className="text-[var(--text-dim)]">
                Devnet token minting in progress...
              </span>
            </div>
          )}
        </div>
      )}

      {/* Devnet mint error — show inline error (minting is automatic, no manual faucet link) */}
      {isDevnet && devnetMintError && !devnetMint && !devnetAirdropAmount && (
        <div className="mb-6 text-[11px] text-[var(--text-dim)]">
          Auto-mint failed ({devnetMintError}). Click &ldquo;Trade This Market&rdquo; and use the airdrop button to get devnet tokens.
        </div>
      )}

      {/* CTAs */}
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        {/* PERC-475: Show "Mint & Trade" on devnet when a mirror mint is available */}
        {isDevnet && devnetMint && publicKey ? (
          <button
            type="button"
            onClick={handleMintAndTrade}
            disabled={mintLoading}
            className="w-full sm:w-auto border border-[var(--long)]/50 bg-[var(--long)]/[0.08] px-8 py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--long)] transition-all hud-btn-corners hover:bg-[var(--long)]/[0.15] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {mintLoading ? (
              <span className="flex items-center gap-2">
                <span className="animate-spin">⟳</span> MINTING…
              </span>
            ) : (
              "MINT & TRADE →"
            )}
          </button>
        ) : (
          <Link
            href={`/trade/${marketAddress}`}
            className="w-full sm:w-auto border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-8 py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all hud-btn-corners hover:bg-[var(--accent)]/[0.15]"
          >
            TRADE THIS MARKET →
          </Link>
        )}
        <button
          type="button"
          onClick={onDeployAnother}
          className="w-full sm:w-auto border border-[var(--border)] bg-transparent px-8 py-3 text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all hud-btn-corners hover:border-[var(--accent)]/30 hover:text-[var(--text)]"
        >
          DEPLOY ANOTHER MARKET
        </button>
      </div>
      {mintError && (
        <p className="mt-2 text-[11px] text-[var(--short)]">{mintError}</p>
      )}

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
