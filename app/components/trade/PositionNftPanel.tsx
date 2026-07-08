"use client";

import { FC, useEffect, useState } from "react";
import { usePositionNft } from "@/hooks/usePositionNft";
import { useMintPositionNft } from "@/hooks/useMintPositionNft";
import { useBurnPositionNft } from "@/hooks/useBurnPositionNft";
import { useTransferPositionNft } from "@/hooks/useTransferPositionNft";
import { useUserAccount } from "@/hooks/useUserAccount";
import { useNftWrappedPosition } from "@/hooks/useNftWrappedPosition";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useTokenMeta } from "@/hooks/useTokenMeta";
import { useMarketInfo } from "@/hooks/useMarketInfo";
import { formatTokenAmount } from "@/lib/format";
import { sanitizeSymbol } from "@/lib/symbol-utils";
import { SendPositionNftModal } from "@/components/trade/SendPositionNftModal";
import { explorerAccountUrl } from "@/lib/config";

/**
 * PositionNftPanel — compact card showing NFT status for the user's position.
 *
 * States:
 *   - No user account (no position)   → disabled card
 *   - Has position, no NFT minted     → "Mint NFT" button
 *   - Has NFT                         → "Active" green badge + mint address
 *   - Closed position with NFT (pendingSettlement) → "Burn NFT" button
 *
 * Styling matches PositionPanel (border/bg CSS vars, mono font, uppercase labels).
 */
export const PositionNftPanel: FC<{ slabAddress: string }> = ({ slabAddress }) => {
  const userAccount = useUserAccount();
  const { hasMintedNft, nftMint, nftPdaAddress, pendingSettlement, isLoading } = usePositionNft(slabAddress);
  const { mint: mintNft, loading: mintLoading, error: mintError } = useMintPositionNft(slabAddress);

  // #13 fix: this scan must run unconditionally, not just when `userAccount`
  // is null. It's the ONLY reliable signal for "the wallet currently holds an
  // NFT-wrapped ACTIVE position" — either self-minted-and-still-held, or
  // RECEIVED via transfer from someone else. Gating it off whenever the
  // wallet ALSO has its own separate unwrapped position (the old
  // `userAccount === null` condition) hid a co-existing received NFT
  // entirely, which is what produced both bugs fixed below: Mint getting
  // wrongly blocked, and the Send modal describing the wrong position.
  const wrapped = useNftWrappedPosition(slabAddress, true);

  // usePositionNft's v17 owner-scan and useNftWrappedPosition's last_holder
  // scan answer different questions and can disagree: a wallet holding a
  // Position NFT transferred in from someone else has no unwrapped portfolio
  // of its own to find via owner-scan, so usePositionNft could still say
  // "not minted" in edge cases even after the owner-scan/fallback fix in
  // usePositionNft itself. Trust EITHER signal, and prefer wrapped's mint/PDA
  // (from the more reliable last_holder scan) when both are present — this is
  // what makes a RECEIVED NFT show "Minted" with Burn enabled.
  const isNftPresent = hasMintedNft || wrapped !== null;
  const effectiveNftMint = wrapped?.nftMint ?? nftMint;
  const effectiveNftPdaAddress = wrapped?.nftPda.toBase58() ?? nftPdaAddress;
  const nftOverride =
    effectiveNftMint && effectiveNftPdaAddress
      ? { nftMint: effectiveNftMint, nftPdaAddress: effectiveNftPdaAddress }
      : undefined;

  const { burn: burnNft, loading: burnLoading, error: burnError } = useBurnPositionNft(slabAddress, nftOverride);
  const { transfer: transferNft, loading: transferLoading, error: transferError } =
    useTransferPositionNft(slabAddress, nftOverride && { nftMint: nftOverride.nftMint });

  const { config: mktConfig } = useSlabState();
  const collateralMeta = useTokenMeta(mktConfig?.collateralMint ?? null);
  const decimals = collateralMeta?.decimals ?? 6;
  const marketInfo = useMarketInfo(slabAddress);
  const assetSymbol = sanitizeSymbol(marketInfo.market?.symbol) ?? "SIZE";

  const [showSendModal, setShowSendModal] = useState(false);

  // Optimistically disable the Mint button the moment a mint is initiated, and
  // keep it disabled until the on-chain state actually reflects the mint. Without
  // this there's a stale window between "tx confirmed / refresh() fired" and
  // usePositionNft re-scanning, during which isNftPresent is still false and a
  // user could click Mint again (double-mint into a failing tx).
  const [pendingMint, setPendingMint] = useState(false);

  // Clear the optimistic guard once the on-chain state confirms the mint.
  useEffect(() => {
    if (isNftPresent) setPendingMint(false);
  }, [isNftPresent]);

  // #13 fix: `usePositionNft`'s single `hasMintedNft`/`isNftPresent` signal
  // conflates two different identities — "my own leg already has an NFT" vs.
  // "I happen to be holding SOME NFT (possibly someone else's, received via
  // transfer)". Using that conflated signal for Mint gating meant a received
  // NFT could permanently block minting on a totally unrelated, still-your-own,
  // never-wrapped position; using `userAccount` for the Send modal's summary
  // meant it could describe YOUR position while actually about to transfer
  // SOMEONE ELSE'S wrapped one.
  //
  // `userAccount` (owner-scan) can only ever reflect a truly-unwrapped
  // position — minting moves ownership to the escrow PDA, so a non-null,
  // non-zero `userAccount` means "this leg has never been wrapped," full
  // stop. That makes it the sole correct signal for Mint eligibility below.
  // For display / Send / Burn, prefer `wrapped` (the NFT actually being
  // acted on, self-held or received) over the own position whenever both
  // exist — it's what `effectiveNftMint`/`effectiveNftPdaAddress` above
  // already resolve to.
  const ownUnwrappedPosition =
    userAccount !== null && userAccount.account.positionSize !== 0n ? userAccount : null;
  const effectiveAccount = wrapped ?? ownUnwrappedPosition;

  // Mint can ONLY ever act on the wallet's own unwrapped leg — never on a
  // held/received NFT — so gate strictly on that, not on `isNftPresent`.
  const hasOwnUnwrappedPosition = ownUnwrappedPosition !== null;
  const mintAddress = effectiveNftMint?.toBase58() ?? null;

  // Summary line for the send modal — e.g. "LONG 0.3507 SOL".
  // Shown read-only so the user can double-check what they're about to transfer
  // before pasting an address.
  const positionSummary = effectiveAccount && effectiveAccount.account.positionSize !== 0n
    ? (() => {
        const size = effectiveAccount.account.positionSize;
        const isLong = size > 0n;
        const absSize = size < 0n ? -size : size;
        return `${isLong ? "LONG" : "SHORT"} ${formatTokenAmount(absSize, decimals)} ${assetSymbol}`;
      })()
    : "No open position";

  // State: no position AND no minted NFT — nothing to show. Centered within
  // whatever height the parent rail gives this panel (see page.tsx's
  // OrderTicketRail — this panel absorbs the rail's remaining height rather
  // than leaving dead space below a small top-anchored card).
  if (!effectiveAccount && !isNftPresent) {
    return (
      <div className="relative flex h-full min-h-[120px] w-full flex-col items-center justify-center p-3 text-center">
        <p className="text-[11px] font-medium text-[var(--text)]">Position NFT</p>
        <p className="mt-1 text-[10px] text-[var(--text-dim)]">Connect wallet to view NFT status.</p>
      </div>
    );
  }

  // Don't unmount the buttons while isLoading — doing that caused the Mint/Burn
  // controls to fully collapse and reappear every time the slab polled (~2s),
  // looking broken. Instead keep the full panel mounted and show a subtle
  // inline spinner in the header until the first fetch lands.
  return (
    <div className="relative flex h-full w-full flex-col">
      {/* Header strip */}
      <div className="flex items-center gap-2 px-3 py-2 border-l-2 border-l-[var(--accent)] bg-[var(--accent)]/[0.06]">
        <span className="text-[13px] leading-none text-[var(--accent)]">◆</span>
        <span className="text-[11px] font-semibold text-[var(--accent)]">POSITION NFT</span>
        {isLoading && (
          <span className="ml-1 h-2 w-2 animate-pulse rounded-full bg-[var(--accent)]/60" aria-hidden />
        )}
        {isNftPresent && (
          <span className="ml-auto text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--long)] bg-[var(--long)]/10 px-1.5 py-0.5">
            Active
          </span>
        )}
      </div>

      <div className="p-3 space-y-2">
        {/* Status row */}
        <div className="flex items-center justify-between py-1">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Status</span>
          <span
            className={`text-[11px] font-semibold ${
              isNftPresent ? "text-[var(--long)]" : "text-[var(--text-muted)]"
            }`}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {isNftPresent ? "Minted" : "Not Minted"}
          </span>
        </div>

        {/* Mint address — shown when NFT exists */}
        {isNftPresent && mintAddress && (
          <div className="flex items-center justify-between py-1 border-t border-[var(--border)]/30">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text)]">Mint</span>
            <a
              href={explorerAccountUrl(mintAddress)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[9px] text-[var(--accent)] transition-colors hover:text-[var(--text)] truncate max-w-[140px]"
              style={{ fontFamily: "var(--font-mono)" }}
              title={mintAddress}
            >
              {mintAddress.slice(0, 8)}…{mintAddress.slice(-6)}
            </a>
          </div>
        )}

        {/* Pending settlement badge */}
        {pendingSettlement && (
          <div className="flex items-center gap-1.5 border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-2 py-1.5">
            <span className="text-[9px] font-medium uppercase tracking-[0.12em] text-[var(--warning)]">
              Pending Settlement
            </span>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 pt-1">
          {/* Mint NFT — enabled when user has a position but no NFT yet */}
          <button
            onClick={async () => {
              setPendingMint(true);
              const sig = await mintNft();
              // Keep the guard set on success (cleared once isNftPresent flips
              // true via the useEffect above). On failure, release it so the
              // user can retry.
              if (!sig) setPendingMint(false);
            }}
            disabled={!hasOwnUnwrappedPosition || mintLoading || pendingMint}
            title={
              !hasOwnUnwrappedPosition
                ? "Open a position first — or it's already wrapped into an NFT"
                : mintLoading || pendingMint
                ? "Minting…"
                : "Mint a position NFT — escrows this ENTIRE sub-account (all free collateral) until burn"
            }
            className="flex-1 rounded-none border border-[var(--long)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--long)] transition-colors duration-150 hover:bg-[var(--long)]/8 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {mintLoading || pendingMint ? "Minting…" : "Mint NFT"}
          </button>

          {/* Send NFT — enabled when NFT exists. Token-2022 TransferChecked
              with our transfer hook attached; the hook atomically updates
              Account.owner in the slab so the destination wallet controls
              the position after the tx lands. */}
          <button
            onClick={() => setShowSendModal(true)}
            disabled={!isNftPresent || transferLoading}
            title={
              !isNftPresent
                ? "Mint the NFT first"
                : transferLoading
                ? "Sending…"
                : "Transfer position to another wallet"
            }
            className="flex-1 rounded-none border border-[var(--accent)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--accent)] transition-colors duration-150 hover:bg-[var(--accent)]/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {transferLoading ? "Sending…" : "Send NFT"}
          </button>

          {/* Burn NFT — enabled when NFT exists and position is closed (pendingSettlement) */}
          <button
            onClick={() => burnNft()}
            disabled={!isNftPresent || burnLoading}
            title={
              !isNftPresent
                ? "No NFT to burn"
                : burnLoading
                ? "Burning…"
                : "Burn the position NFT"
            }
            className="flex-1 rounded-none border border-[var(--short)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-colors duration-150 hover:bg-[var(--short)]/8 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {burnLoading ? "Burning…" : "Burn NFT"}
          </button>
        </div>

        {/* #36: Minting doesn't just tokenize this one position — the escrow
            CPI moves the ENTIRE sub-account (all free collateral in it, not
            only the margin backing this leg) into the NFT, and it stays
            locked there until burn. Surface that before the user clicks Mint. */}
        {hasOwnUnwrappedPosition && !isNftPresent && (
          <p className="pt-0.5 text-[9px] leading-snug text-[var(--warning)]">
            Minting escrows your ENTIRE sub-account — all free collateral, not just
            this position — into the NFT until you burn it.
          </p>
        )}

        {/* Error display */}
        {(mintError || burnError || transferError) && (
          <div className="rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
            <p className="text-[10px] text-[var(--short)]">{mintError || burnError || transferError}</p>
          </div>
        )}
      </div>

      {showSendModal && isNftPresent && mintAddress && (
        <SendPositionNftModal
          positionSummary={positionSummary}
          nftMintShort={`${mintAddress.slice(0, 8)}…${mintAddress.slice(-6)}`}
          loading={transferLoading}
          error={transferError}
          onCancel={() => setShowSendModal(false)}
          onConfirm={async (dest) => {
            const sig = await transferNft(dest);
            if (sig) setShowSendModal(false);
          }}
        />
      )}
    </div>
  );
};
