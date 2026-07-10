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
  /**
   * GH#1761: Insurance LP Mint (step 5) failed but market is live.
   * Shows a soft warning on the success screen; does not block trading.
   */
  insuranceMintFailed?: boolean;
  /** Keeper oracle: true when oracle_authority was delegated to the keeper service */
  keeperDelegated?: boolean;
  /** Keeper registration message */
  keeperMessage?: string | null;
  /** True while a "Retry registration" call is in flight */
  keeperRegistering?: boolean;
  /**
   * BUG FIX (2026-07-09): re-runs just the keeper-register step for an
   * already-on-chain market. Registration can fail non-fatally for reasons the
   * user CAN fix (wallet couldn't sign, transient network error) — without this,
   * a market that lands on-chain but fails registration stayed permanently
   * unpriced with no recourse short of re-deploying. See useCreateMarket.ts's
   * retryKeeperRegistration.
   */
  onRetryKeeperRegistration?: () => void | Promise<void>;
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
  insuranceMintFailed,
  keeperDelegated,
  keeperMessage,
  keeperRegistering,
  onRetryKeeperRegistration,
}) => {
  const [copied, setCopied] = useState(false);
  const [copiedDevnet, setCopiedDevnet] = useState(false);
  const [mintLoading, setMintLoading] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const isDevnet = getNetwork() === "devnet";
  const { publicKey } = useWalletCompat();
  const router = useRouter();

  /**
   * PERC-475: Claim ~$500 of Sim-USDC collateral, then navigate to the trade page.
   * GH#1266: Always navigate to trade page regardless of the claim's outcome.
   *
   * BUG FIX (2026-07-09): `devnetMint` here is the Sim-USDC collateral mint, NOT a
   * devnet mint of the token the user just launched — Percolator markets don't have
   * one; the launched token is a price reference only (see the collateral/pricing
   * card below). Renamed from the previous "mint tokens" framing, which implied
   * this was minting the launched asset.
   */
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
      // GH#1266: On claim failure, show a brief warning but still navigate.
      // Previously we returned early here, leaving the user stranded with an error banner.
      if (!resp.ok && resp.status !== 429) {
        const d = await resp.json().catch(() => ({}));
        setMintError(d.error ?? "Sim-USDC faucet claim failed — you can claim it from the faucet on the trade page");
      }
    } catch {
      // Network error — still navigate
    }
    // Always navigate regardless of claim outcome
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
          className="border border-[var(--border)] px-2 py-1.5 text-[9px] font-medium text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/30 transition-colors"
          title="Copy address"
        >
          {copied ? "✓" : "copy"}
        </button>
        <a
          href={`https://explorer.solana.com/address/${marketAddress}?cluster=devnet`}
          target="_blank"
          rel="noopener noreferrer"
          className="border border-[var(--border)] px-2 py-1.5 text-[9px] font-medium text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/30 transition-colors"
          title="View on Solscan"
        >
          Explorer ↗
        </a>
      </div>

      {/* Keeper oracle delegation badge */}
      {keeperDelegated && (
        <div className="mb-4 border border-[var(--long)]/30 bg-[var(--long)]/[0.06] px-4 py-2.5 text-[11px] text-[var(--long)]">
          Keeper oracle active — oracle_authority delegated to the Percolator keeper.
          The market is live now; mainnet DEX prices typically start flowing within
          ~1&ndash;2 minutes while the keeper&apos;s register-poll cycle picks it up.
        </div>
      )}
      {!keeperDelegated && keeperMessage && (
        <div className="mb-4 border border-[var(--warning)]/30 bg-[var(--warning)]/[0.04] px-4 py-2.5 text-left text-[11px] text-[var(--text-secondary)]">
          <p>Keeper registration: {keeperMessage}</p>
          {onRetryKeeperRegistration && (
            <button
              type="button"
              onClick={() => void onRetryKeeperRegistration()}
              disabled={keeperRegistering}
              className="mt-2.5 border border-[var(--warning)]/40 bg-[var(--warning)]/[0.06] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--warning)] transition-colors hover:bg-[var(--warning)]/[0.12] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {keeperRegistering ? (
                <span className="flex items-center gap-1.5">
                  <span className="animate-spin">⟳</span> RETRYING…
                </span>
              ) : (
                "RETRY REGISTRATION"
              )}
            </button>
          )}
        </div>
      )}

      {/* Market preview card */}
      <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.02] p-4 mb-6 inline-block text-left w-full max-w-sm mx-auto">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center border border-[var(--accent)]/30 bg-[var(--accent)]/[0.08] text-[11px] font-bold text-[var(--accent)]">
            {tokenSymbol.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <p className="text-[13px] font-bold text-[var(--text)]">{tokenSymbol}-PERP</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[9px] text-[var(--text-secondary)]">Fee: {tradingFeeBps} bps</span>
              <span className="text-[9px] text-[var(--text-secondary)]">·</span>
              <span className="text-[9px] text-[var(--text-secondary)]">Leverage: {maxLeverage}x</span>
              <span className="text-[9px] text-[var(--text-secondary)]">·</span>
              <span className="text-[9px] text-[var(--text-secondary)]">Slab: {slabLabel}</span>
            </div>
          </div>
        </div>
      </div>

      {/* GH#1761: Insurance LP Mint soft warning — shown when step 5 failed non-fatally */}
      {insuranceMintFailed && (
        <div className="border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] p-4 mb-4 text-left w-full max-w-sm mx-auto">
          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--warning)] mb-2">
            INSURANCE LP MINT PENDING
          </p>
          <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
            Your market is <strong className="text-[var(--text)]">live and tradeable</strong>. The Insurance LP Mint transaction timed out on devnet — this is non-blocking.
          </p>
          <p className="text-[11px] text-[var(--text-secondary)] mt-1.5 leading-relaxed">
            Insurance LP deposits will be unavailable until the mint is created. You can retry from the market settings page later.
          </p>
        </div>
      )}

      {/*
        Collateral & pricing — BUG FIX (2026-07-09): this card previously called
        itself "DEVNET TOKEN INFO" and showed `devnetMint` as if it were a devnet
        mint of the token the user just launched ("Airdropped 1,000 TOKEN...
        Devnet uses a different mint address than mainnet"). That's wrong on both
        counts:
          1. Percolator markets don't have a devnet mint of the traded token at
             all — `devnetMint` here is always the Sim-USDC collateral mint (see
             CreateMarketWizard.tsx's collateralMintAddress: on devnet it's
             ALWAYS testUsdcMint, never a per-market mirror of the launched
             token — that mirror-mint collateral model was removed).
          2. The launched token (mainnetCA) is a PRICE REFERENCE only — this
             market is priced off its live mainnet DEX pool via the keeper. You
             never hold or receive that token on devnet; you trade with Sim-USDC,
             the same collateral shared by every Percolator market.
        Reframed below to describe what's actually happening: a Sim-USDC
        collateral top-up, plus a note on how the market gets its price.
      */}
      {isDevnet && (devnetMint || devnetAirdropAmount || devnetMintError) && (
        <div className="border border-[var(--accent)]/20 bg-[var(--accent)]/[0.03] p-4 mb-6 text-left w-full max-w-sm mx-auto space-y-3">
          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--accent)]">
            COLLATERAL &amp; PRICING
          </p>

          <p className="text-[10px] text-[var(--text-secondary)] leading-relaxed">
            You trade with <strong className="text-[var(--text)]">Sim-USDC</strong> — one collateral
            balance shared across every Percolator market, topped up once from the faucet.
          </p>

          {devnetAirdropAmount && devnetAirdropSymbol && (
            <div className="flex items-center gap-2 text-[12px]">
              <span className="text-[var(--long)]">✓</span>
              <span className="text-[var(--text)]">
                Sent <strong>{devnetAirdropAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {devnetAirdropSymbol}</strong>{" "}
                <span className="text-[var(--text-secondary)]">(~$500 of Sim-USDC) to your wallet</span>
              </span>
            </div>
          )}

          {devnetMint && (
            <div className="flex items-center gap-2 text-[10px]">
              <span className="text-[var(--accent)] w-16 flex-shrink-0 font-medium">Sim-USDC:</span>
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
                className="border border-[var(--border)] px-1.5 py-0.5 text-[8px] font-medium text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/30 transition-colors flex-shrink-0"
              >
                {copiedDevnet ? "✓" : "copy"}
              </button>
            </div>
          )}

          {mainnetCA && (
            <p className="text-[9px] text-[var(--text-secondary)] leading-relaxed">
              {tokenSymbol} itself is a <strong className="text-[var(--text)]">price reference only</strong> —
              this market is priced off its live mainnet DEX pool via the keeper. You never hold or
              receive {tokenSymbol} on devnet.
            </p>
          )}

          {devnetMintError && (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-[var(--short)]">✗</span>
              <span className="text-[var(--short)]">
                Sim-USDC faucet claim failed: {devnetMintError}
              </span>
            </div>
          )}

          {!devnetMint && !devnetAirdropAmount && !devnetMintError && (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-[var(--text-dim)]">⏳</span>
              <span className="text-[var(--text-dim)]">
                Sending Sim-USDC collateral...
              </span>
            </div>
          )}
        </div>
      )}

      {/* Sim-USDC faucet claim error — shown inline (claiming is automatic, no manual link needed) */}
      {isDevnet && devnetMintError && !devnetMint && !devnetAirdropAmount && (
        <div className="mb-6 text-[11px] text-[var(--text-secondary)]">
          Sim-USDC faucet claim failed ({devnetMintError}). Click &ldquo;Trade This Market&rdquo; and use the faucet button there to get Sim-USDC.
        </div>
      )}

      {/* CTAs */}
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        {/* PERC-475: Claim Sim-USDC collateral + trade on devnet when a collateral mint is available */}
        {isDevnet && devnetMint && publicKey ? (
          <button
            type="button"
            onClick={handleMintAndTrade}
            disabled={mintLoading}
            className="w-full sm:w-auto border border-[var(--long)]/50 bg-[var(--long)]/[0.08] px-8 py-3 text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--long)] transition-all hud-btn-corners hover:bg-[var(--long)]/[0.15] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {mintLoading ? (
              <span className="flex items-center gap-2">
                <span className="animate-spin">⟳</span> FUNDING…
              </span>
            ) : (
              "GET SIM-USDC & TRADE →"
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
        {/* /my-markets had zero navigational entry point — link to it here, at
            the moment a creator has just proven they own a market, so they can
            find their creator dashboard again later. */}
        <Link
          href="/my-markets"
          className="w-full sm:w-auto border border-[var(--border)] bg-transparent px-8 py-3 text-center text-[12px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)] transition-all hud-btn-corners hover:border-[var(--accent)]/30 hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
        >
          VIEW MY MARKETS
        </Link>
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
      <LogoUpload slabAddress={marketAddress} mainnetCa={mainnetCA} />

      {/* Transaction signatures */}
      {txSigs.length > 0 && (
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <p className="text-[9px] font-medium uppercase tracking-[0.15em] text-[var(--text)] mb-2">
            Transactions
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {txSigs.map((sig, i) => (
              <a
                key={i}
                href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors"
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
