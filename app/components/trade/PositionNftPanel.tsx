"use client";

import { FC } from "react";
import { usePositionNft } from "@/hooks/usePositionNft";
import { useMintPositionNft } from "@/hooks/useMintPositionNft";
import { useBurnPositionNft } from "@/hooks/useBurnPositionNft";
import { useUserAccount } from "@/hooks/useUserAccount";
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
  const { hasMintedNft, nftMint, pendingSettlement, isLoading } = usePositionNft(slabAddress);
  const { mint: mintNft, loading: mintLoading, error: mintError } = useMintPositionNft(slabAddress);
  const { burn: burnNft, loading: burnLoading, error: burnError } = useBurnPositionNft(slabAddress);

  const hasPosition = userAccount !== null && userAccount.account.positionSize !== 0n;
  const mintAddress = nftMint?.toBase58() ?? null;

  // State: no user account at all
  if (!userAccount) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex flex-col items-center py-4 text-center">
          <p className="text-[11px] font-medium text-[var(--text-muted)]">Position NFT</p>
          <p className="mt-1 text-[10px] text-[var(--text-dim)]">Connect wallet to view NFT status.</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80 p-3">
        <div className="flex items-center gap-2 px-3 py-2 border-l-2 border-l-[var(--accent)] bg-[var(--accent)]/[0.06]">
          <span className="text-[11px] font-semibold text-[var(--accent)]">POSITION NFT</span>
        </div>
        <div className="p-3">
          <p className="text-[10px] text-[var(--text-muted)]">Loading NFT status…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative rounded-none border border-[var(--border)]/50 bg-[var(--bg)]/80">
      {/* Header strip */}
      <div className="flex items-center gap-2 px-3 py-2 border-l-2 border-l-[var(--accent)] bg-[var(--accent)]/[0.06]">
        <span className="text-[13px] leading-none text-[var(--accent)]">◆</span>
        <span className="text-[11px] font-semibold text-[var(--accent)]">POSITION NFT</span>
        {hasMintedNft && (
          <span className="ml-auto text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--long)] bg-[var(--long)]/10 px-1.5 py-0.5">
            Active
          </span>
        )}
      </div>

      <div className="p-3 space-y-2">
        {/* Status row */}
        <div className="flex items-center justify-between py-1">
          <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Status</span>
          <span
            className={`text-[11px] font-semibold ${
              hasMintedNft ? "text-[var(--long)]" : "text-[var(--text-muted)]"
            }`}
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {hasMintedNft ? "Minted" : "Not Minted"}
          </span>
        </div>

        {/* Mint address — shown when NFT exists */}
        {hasMintedNft && mintAddress && (
          <div className="flex items-center justify-between py-1 border-t border-[var(--border)]/30">
            <span className="text-[10px] uppercase tracking-[0.15em] text-[var(--text-dim)]">Mint</span>
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
            onClick={() => mintNft()}
            disabled={!hasPosition || hasMintedNft || mintLoading}
            title={
              !hasPosition
                ? "Open a position first"
                : hasMintedNft
                ? "NFT already minted"
                : mintLoading
                ? "Minting…"
                : "Mint a position NFT"
            }
            className="flex-1 rounded-none border border-[var(--long)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--long)] transition-all duration-150 hover:bg-[var(--long)]/8 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {mintLoading ? "Minting…" : "Mint NFT"}
          </button>

          {/* Burn NFT — enabled when NFT exists and position is closed (pendingSettlement) */}
          <button
            onClick={() => burnNft()}
            disabled={!hasMintedNft || burnLoading}
            title={
              !hasMintedNft
                ? "No NFT to burn"
                : burnLoading
                ? "Burning…"
                : "Burn the position NFT"
            }
            className="flex-1 rounded-none border border-[var(--short)]/30 py-2 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--short)] transition-all duration-150 hover:bg-[var(--short)]/8 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {burnLoading ? "Burning…" : "Burn NFT"}
          </button>
        </div>

        {/* Error display */}
        {(mintError || burnError) && (
          <div className="rounded-none border border-[var(--short)]/20 bg-[var(--short)]/5 px-3 py-2">
            <p className="text-[10px] text-[var(--short)]">{mintError || burnError}</p>
          </div>
        )}
      </div>
    </div>
  );
};
