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
  /** GH#2514: backing-domain seeding failed (non-fatal, but must not be silent). */
  backingSeedFailed?: boolean;
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
  marketAddress,
  txSigs,
  onDeployAnother,
  mainnetCA,
  devnetMint,
  devnetAirdropAmount,
  devnetAirdropSymbol,
  devnetMintError,
  insuranceMintFailed,
  backingSeedFailed,
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
        <div className="mb-4 border border-[var(--long)]/30 bg-[var(--long)]/[0.06] px-4 py-2 text-[11px] text-[var(--long)]">
          Price feed connected — live prices start within ~1–2 min.
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
              {/* v17 slabs are always sized to max capacity — there is no tier to
                  report here anymore (see StepControlRoom's "Slab" pre-flight readout). */}
              <span className="text-[9px] text-[var(--text-secondary)]">Slab: Max capacity</span>
            </div>
          </div>
        </div>
      </div>

      {/* GH#2514: backing-domain seeding failed. Non-fatal by design — a transient
          RPC error must not strand a live market — but it must not be silent
          either: at the current policy each domain's seed is 100% of LP
          collateral, so an unreported failure leaves the creator believing a
          market is seeded when it is short twice their LP. */}
      {backingSeedFailed && (
        <div className="border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] px-4 py-2 mb-4 text-left w-full max-w-sm mx-auto">
          <p className="text-[11px] text-[var(--text-secondary)]">
            Market is <strong className="text-[var(--text)]">live and tradeable</strong>, but counterparty backing was <strong className="text-[var(--text)]">not seeded</strong> — the deposit for both domains did not land. Retry it from market settings before the market takes size.
          </p>
        </div>
      )}

      {/* GH#1761: Insurance LP Mint soft warning — shown when step 5 failed non-fatally */}
      {insuranceMintFailed && (
        <div className="border border-[var(--warning)]/20 bg-[var(--warning)]/[0.04] px-4 py-2 mb-4 text-left w-full max-w-sm mx-auto">
          <p className="text-[11px] text-[var(--text-secondary)]">
            Market is <strong className="text-[var(--text)]">live and tradeable</strong>. LP-vault deposits are pending (mint timed out) — retry later from market settings.
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
        <div className="mb-5 w-full max-w-sm mx-auto text-left">
          {/* One line for the thing that actually matters to the creator right
              now — did the collateral land. Everything explanatory moved into
              the disclosure below: the success screen was a wall of text. */}
          {devnetAirdropAmount && devnetAirdropSymbol ? (
            <p className="text-[11px] text-[var(--text)]">
              <span className="text-[var(--long)]">✓</span>{" "}
              Sent <strong>{devnetAirdropAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {devnetAirdropSymbol}</strong>{" "}
              <span className="text-[var(--text-secondary)]">of Sim-USDC to your wallet</span>
            </p>
          ) : devnetMintError ? (
            <p className="text-[11px] text-[var(--short)]">
              ✗ Sim-USDC claim failed — use the faucet on the trade page.
            </p>
          ) : (
            <p className="text-[11px] text-[var(--text-dim)]">⏳ Sending Sim-USDC…</p>
          )}

          <details className="mt-3 group">
            <summary className="cursor-pointer list-none text-[10px] uppercase tracking-[0.12em] text-[var(--text-dim)] transition-colors hover:text-[var(--text-secondary)]">
              Details <span className="inline-block transition-transform group-open:rotate-90">›</span>
            </summary>
            <div className="mt-2 space-y-2 border-l border-[var(--border)] pl-3">
              <p className="text-[10px] leading-relaxed text-[var(--text-secondary)]">
                You trade with <strong className="text-[var(--text)]">Sim-USDC</strong> — one balance shared
                across every market.{mainnetCA ? ` ${tokenSymbol} is a price reference only: the market is priced off its live mainnet DEX pool. You never hold ${tokenSymbol} on devnet.` : ""}
              </p>
              <p className="text-[10px] leading-relaxed text-[var(--text-secondary)]">
                The <strong className="text-[var(--text)]">liquidity you seeded</strong> backs this market as
                its counterparty — it is not part of your tradeable balance.
              </p>
              {devnetMint && (
                <div className="flex items-center gap-2 text-[10px]">
                  <span className="flex-shrink-0 font-medium text-[var(--text-dim)]">Sim-USDC mint</span>
                  <code className="flex-1 truncate font-mono text-[9px] text-[var(--text-secondary)]">{devnetMint}</code>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(devnetMint);
                        setCopiedDevnet(true);
                        setTimeout(() => setCopiedDevnet(false), 2000);
                      } catch {}
                    }}
                    className="flex-shrink-0 border border-[var(--border)] px-1.5 py-0.5 text-[8px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)]/30 hover:text-[var(--accent)]"
                  >
                    {copiedDevnet ? "✓" : "copy"}
                  </button>
                </div>
              )}
              {txSigs.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
                  {txSigs.map((sig, i) => (
                    <a
                      key={i}
                      href={`https://explorer.solana.com/tx/${sig}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-[9px] text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
                    >
                      tx {i + 1} ↗
                    </a>
                  ))}
                </div>
              )}
            </div>
          </details>
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

      {/* Transaction signatures moved into the "Details" disclosure above —
          they were a full labelled section on a screen that had grown into a
          wall of text. Non-devnet (no collateral card, hence no disclosure)
          keeps them here so the links never disappear entirely. */}
      {!isDevnet && txSigs.length > 0 && (
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <div className="flex flex-wrap justify-center gap-3">
            {txSigs.map((sig, i) => (
              <a
                key={i}
                href={`https://explorer.solana.com/tx/${sig}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[9px] text-[var(--text-dim)] transition-colors hover:text-[var(--accent)]"
              >
                tx {i + 1} ↗
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
