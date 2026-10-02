"use client";

import { bpsPct } from "@/lib/format";
import { FC, useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogoUpload } from "./LogoUpload";
import { getNetwork, explorerTxUrl, explorerAccountUrl } from "@/lib/config";
import { useWalletCompat } from "@/hooks/useWalletCompat";
import { launchPriceFeedStatus } from "@/lib/launch-outcome";
import { KEEPER_REGISTER_COPY, userFacingRegistrationReason } from "@/lib/keeper-register-client";

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
  /** E2E B21: the market's price comes from a keeper-read DEX pool, so it is not launched
   *  until the keeper registration succeeds. */
  priceFeedRequired?: boolean;
  /** UX WP-7: the background registration loop's phase (connecting / slow / ready / failed). */
  keeperPhase?: "connecting" | "slow" | "ready" | "failed" | null;
}

/**
 * The success screen shows its actions as soon as the market's creation has landed; the live-price
 * registration is a secondary one-line status next to them. That status is bounded: after
 * LAUNCH_PRICE_WAIT_MS without a connection it settles on a calm final line (with Retry) instead of
 * an open-ended spinner. (WP-7 replaced the whole screen with an "Almost ready" waiting state that
 * hid Trade / Sim-USDC / copy until the price connected, which could be forever.)
 */
export const LAUNCH_PRICE_WAIT_MS = 90_000;
export const LAUNCH_PRICE_COPY = {
  pendingTitle: "Market created",
  readyTitle: "Ready to trade",
  connecting: "Live price connecting… usually under a minute.",
  timedOut: "Live price is still connecting; your market is live and tradable once it arrives.",
  failed: KEEPER_REGISTER_COPY.serverTrouble,
  ready: KEEPER_REGISTER_COPY.ready,
  retry: "Retry",
  retrying: "Retrying…",
} as const;

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
  insuranceMintFailed,
  backingSeedFailed,
  keeperDelegated,
  keeperMessage,
  keeperRegistering,
  onRetryKeeperRegistration,
  priceFeedRequired = false,
  keeperPhase = null,
}) => {
  const feed = launchPriceFeedStatus({ priceFeedRequired, keeperDelegated: !!keeperDelegated });
  const [copied, setCopied] = useState(false);
  const [copiedDevnet, setCopiedDevnet] = useState(false);
  const [mintLoading, setMintLoading] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const isDevnet = getNetwork() === "devnet";
  const { publicKey } = useWalletCompat();
  const router = useRouter();

  const pricePending = feed === "missing";
  const [priceTimedOut, setPriceTimedOut] = useState(false);
  useEffect(() => {
    if (!pricePending) return;
    const t = setTimeout(() => setPriceTimedOut(true), LAUNCH_PRICE_WAIT_MS);
    return () => clearTimeout(t);
  }, [pricePending]);
  const priceFailed = pricePending && keeperPhase === "failed";
  const priceStatus: "connecting" | "timed-out" | "failed" | "ready" | null = !priceFeedRequired
    ? null
    : !pricePending
      ? "ready"
      : priceFailed
        ? "failed"
        : priceTimedOut
          ? "timed-out"
          : "connecting";
  const priceLine =
    priceStatus === "connecting"
      ? LAUNCH_PRICE_COPY.connecting
      : priceStatus === "timed-out"
        ? LAUNCH_PRICE_COPY.timedOut
        : priceStatus === "failed"
          ? keeperMessage
            ? userFacingRegistrationReason(keeperMessage)
            : LAUNCH_PRICE_COPY.failed
          : priceStatus === "ready"
            ? LAUNCH_PRICE_COPY.ready
            : null;
  // Without the creation tx on this device a retry can only repeat the same message, so none is offered.
  const noProofHere = keeperMessage === KEEPER_REGISTER_COPY.noProof;
  const showPriceRetry =
    !!onRetryKeeperRegistration && !noProofHere && (priceStatus === "failed" || priceStatus === "timed-out");

  /**
   * PERC-475: Claim ~$500 of Sim-USDC collateral, then navigate to the trade page.
   *
   * BUG FIX (2026-07-09): `devnetMint` here is the Sim-USDC collateral mint, NOT a
   * devnet mint of the token the user just launched — Percolator markets don't have
   * one; the launched token is a price reference only (see the collateral/pricing
   * card below). Renamed from the previous "mint tokens" framing, which implied
   * this was minting the launched asset.
   *
   * GH#2610 (defect 3): GH#1266 made this ALWAYS navigate regardless of outcome,
   * so a genuine claim failure's message (`mintError`, rendered below) never had a
   * chance to be seen — the component unmounted on the very next line. Now only a
   * SUCCESS or an already-claimed 429 navigates; every other outcome stays here and
   * shows the actual reason, with an explicit way to continue anyway instead of a
   * dead end. (This used to read "a 429 still navigates" — too broad; see the 429
   * note inside the handler.)
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
      if (resp.ok) {
        router.push(`/trade/${marketAddress}`);
        return;
      }
      const d = (await resp.json().catch(() => ({}))) as { error?: string; nextClaimAt?: string };
      // A 429 can arrive from three places, and only ONE means a claim was
      // actually made:
      //
      //   - the route's daily claim gate — 429 WITH `nextClaimAt`, so the gate
      //     has a claim on record for this wallet;
      //   - the route's per-IP fund limiter — Retry-After, no `nextClaimAt`,
      //     mints NOTHING;
      //   - middleware.ts's global per-IP API limiter, which 429s any /api/*
      //     path before this route runs at all. No `nextClaimAt` either, and it
      //     is arguably the 429 a real creator is most likely to hit.
      //
      // `resp.status === 429` alone treated all three as success and sent a
      // rate-limited creator to the trade page with no collateral and no
      // message. Discriminating on `nextClaimAt` classifies all three correctly
      // and fails closed for any 429 we have not anticipated — including a
      // non-JSON one from a CDN or WAF, where the parse falls back to `{}`.
      //
      // Note what the pass actually means: "the gate says this wallet already
      // claimed", NOT "the wallet holds tokens". A claim can be on record while
      // the balance is zero — tokens spent, or a claim leaked by a failed mint
      // (the GH#2597 class). That was equally true before this change, and
      // navigating on is still right: the trade page is where they would go to
      // check a balance anyway.
      const alreadyHasTokens = resp.status === 429 && typeof d.nextClaimAt === "string";
      if (alreadyHasTokens) {
        router.push(`/trade/${marketAddress}`);
        return;
      }
      setMintLoading(false);
      setMintError(d.error ?? `Sim-USDC claim failed (HTTP ${resp.status})`);
    } catch (e) {
      setMintLoading(false);
      setMintError(e instanceof Error ? e.message : "Network error — could not reach the faucet.");
    }
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
    <div data-testid="launch-success" className="border border-[var(--long)]/30 bg-[var(--long)]/[0.06] p-6 text-center">
      {/* Success icon */}
      <div className="mb-4">
        <div className="inline-flex h-12 w-12 items-center justify-center border-2 border-[var(--long)]/40 bg-[var(--long)]/[0.1] text-[24px] text-[var(--long)]">
          ✓
        </div>
      </div>

      <h2 className="text-[18px] font-bold text-[var(--long)] mb-2">
        {pricePending ? LAUNCH_PRICE_COPY.pendingTitle : LAUNCH_PRICE_COPY.readyTitle}
      </h2>
      <p className="text-[13px] text-[var(--text-secondary)] mb-4">
        {tokenSymbol} is live on Percolator devnet
      </p>

      {/* Market address */}
      <div className="flex items-center justify-center gap-2 mb-4">
        <code className="font-mono text-[10px] text-[var(--accent)]/80 bg-[var(--bg)] border border-[var(--border)] px-3 py-1.5 break-all">
          {marketAddress}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          data-testid="launch-copy-address"
          className="border border-[var(--border)] px-2 py-1.5 text-[9px] font-medium text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/30 transition-colors"
          title="Copy address"
        >
          {copied ? "✓" : "copy"}
        </button>
        <a
          href={explorerAccountUrl(marketAddress)}
          target="_blank"
          rel="noopener noreferrer"
          className="border border-[var(--border)] px-2 py-1.5 text-[9px] font-medium text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]/30 transition-colors"
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
            <p className="text-[13px] font-bold text-[var(--text)]">{tokenSymbol}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-[9px] text-[var(--text-secondary)]">Fee: {bpsPct(tradingFeeBps)}</span>
              <span className="text-[9px] text-[var(--text-secondary)]">·</span>
              <span className="text-[9px] text-[var(--text-secondary)]">Leverage: {maxLeverage}x</span>
              <span className="text-[9px] text-[var(--text-secondary)]">·</span>
              {/* v17 slabs are always sized to max capacity — there is no tier to
                  report here anymore (see StepControlRoom's "Slab" pre-flight readout). */}
              <span className="text-[9px] text-[var(--text-secondary)]">Market size: max capacity</span>
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
            Market is <strong className="text-[var(--text)]">live and tradeable</strong>. Earn deposits aren't open yet (the setup step timed out). Retry later from My Markets.
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
      {isDevnet && devnetMint && (
        <div className="mb-5 w-full max-w-sm mx-auto text-left">
          {/* GH#2608/#2610: this used to reflect an automatic background claim
              that fired the instant the market landed (see useCreateMarket.ts).
              That call is gone — it duplicated the "GET SIM-USDC & TRADE" button
              below, and every one of its failure modes (500, 429, stuck spinner)
              was unreportable here.

              287f0c7 kept a two-way branch here on devnetAirdropAmount /
              devnetMintError and fixed the "show the real reason" defect inside
              it. But removing the automatic claim removed the only writer of
              those props: the hook set them to null at its two initial-state
              sites and nowhere else, and this component has no local state for
              them — they arrived from CreateMarketWizard as `createState.*`.
              Both arms were therefore unreachable, so the reason-printing fix
              was dead code and this panel rendered NOTHING above the disclosure:
              a creator saw no statement of what Sim-USDC is or where to get it.
              The props are deleted rather than left permanently null, so the
              branch cannot come back by a caller passing them again.

              The claim's outcome belongs to the button that makes it, which
              reports it through this component's own `mintError` state below. */}
          <p className="text-[11px] text-[var(--text-secondary)]">
            <strong className="text-[var(--text)]">Sim-USDC</strong> is your collateral —
            claim it any time from the{" "}
            <Link href="/faucet" className="text-[var(--accent)] underline underline-offset-2">faucet</Link>.
          </p>

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
                      href={explorerTxUrl(sig)}
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
        {isDevnet && devnetMint && publicKey && (
          <button
            type="button"
            onClick={handleMintAndTrade}
            data-testid="launch-claim-sim-usdc"
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
        )}
        {/* Always present, from the moment the market's creation lands — even while the live price
            is still connecting, and alongside the Sim-USDC claim when that is offered. */}
        <Link
          href={`/trade/${marketAddress}`}
          data-testid="launch-go-to-market"
          className="w-full sm:w-auto border border-[var(--accent)]/50 bg-[var(--accent)]/[0.08] px-8 py-3 text-center text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--accent)] transition-all hud-btn-corners hover:bg-[var(--accent)]/[0.15]"
        >
          TRADE THIS MARKET →
        </Link>
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
      {priceLine && (
        <div
          data-testid="launch-price-status"
          data-status={priceStatus ?? undefined}
          className="mx-auto mt-3 flex max-w-md flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[11px] text-[var(--text-secondary)]"
        >
          {priceStatus === "connecting" && (
            <span aria-hidden="true" className="inline-block h-[6px] w-[6px] animate-pulse rounded-full bg-[var(--text-muted)]" />
          )}
          <span data-testid="launch-price-status-line">{priceLine}</span>
          {showPriceRetry && (
            <button
              type="button"
              data-testid="launch-price-retry"
              onClick={() => void onRetryKeeperRegistration?.()}
              disabled={keeperRegistering}
              className="text-[var(--accent)] underline underline-offset-2 hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {keeperRegistering ? LAUNCH_PRICE_COPY.retrying : LAUNCH_PRICE_COPY.retry}
            </button>
          )}
        </div>
      )}
      {mintError && (
        <div className="mt-2 text-[11px] text-[var(--short)]">
          <p>{mintError}</p>
          {/* GH#2610 (defect 3): an actionable path instead of a dead end — retry
              via the button above, or skip the claim and go trade (the faucet on
              the trade page can claim it later). */}
          <button
            type="button"
            onClick={() => router.push(`/trade/${marketAddress}`)}
            className="mt-1 text-[var(--accent)] underline underline-offset-2 hover:text-[var(--text)]"
          >
            Continue to trade page without claiming →
          </button>
        </div>
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
