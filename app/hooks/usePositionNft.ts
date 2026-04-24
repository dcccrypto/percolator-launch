"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUserAccount } from "@/hooks/useUserAccount";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";
import {
  deriveNftPda,
  parsePositionNftAccount,
  POSITION_NFT_STATE_LEN,
  PERCOLATOR_NFT_PROGRAM_ID,
} from "@/lib/nft-program";

export interface UsePositionNftResult {
  /** Whether the position NFT has been minted (PDA account exists on-chain) */
  hasMintedNft: boolean;
  /** The NFT mint address (if minted) */
  nftMint: PublicKey | null;
  /** Whether the position is pending settlement */
  pendingSettlement: boolean;
  /** The position_nft PDA address (always available once slab + user loaded) */
  nftPdaAddress: string | null;
  /** Loading state */
  isLoading: boolean;
}

/**
 * Hook: derives the position_nft PDA for the current user, fetches the
 * account, and parses the NFT mint + settlement flag.
 *
 * PDA seeds: ["position_nft", slab, user_idx_u16_LE]
 * Layout per percolator-nft program (PERC-303).
 */
export function usePositionNft(slabAddress: string): UsePositionNftResult {
  const { connection } = useConnectionCompat();
  const userAccount = useUserAccount();
  const { programId: slabProgramId } = useSlabState();
  const mockMode = isMockMode() && isMockSlab(slabAddress);

  const [state, setState] = useState<UsePositionNftResult>({
    hasMintedNft: false,
    nftMint: null,
    pendingSettlement: false,
    nftPdaAddress: null,
    isLoading: false,
  });

  // Stabilise effect deps with primitives. `userAccount` and `connection` object
  // references are recreated on every slab poll (~2s), which used to re-trigger
  // the entire fetch and flash isLoading=true — making the Mint/Burn buttons
  // visibly disappear and reappear every 2–3s. The NFT PDA account only
  // changes when the user index or program/slab identity changes, so key the
  // effect on those primitives alone. Refetches after mint/burn can be
  // wired later via a manual trigger if needed.
  const userIdx = userAccount?.idx ?? null;
  const programIdStr = slabProgramId?.toBase58() ?? null;

  useEffect(() => {
    if (userIdx === null || !programIdStr || !slabAddress) {
      setState({
        hasMintedNft: false,
        nftMint: null,
        pendingSettlement: false,
        nftPdaAddress: null,
        isLoading: false,
      });
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const slabPk = new PublicKey(slabAddress);
        const [nftPda] = deriveNftPda(slabPk, userIdx, PERCOLATOR_NFT_PROGRAM_ID);
        const pdaStr = nftPda.toBase58();

        if (mockMode) {
          if (!cancelled) {
            setState({
              hasMintedNft: false,
              nftMint: null,
              pendingSettlement: false,
              nftPdaAddress: pdaStr,
              isLoading: false,
            });
          }
          return;
        }

        // Only flip isLoading on the FIRST fetch (when we have no data yet).
        // Subsequent refetches — which shouldn't happen any more thanks to the
        // stable deps above, but belt-and-braces — keep the cached state
        // visible so the UI doesn't flash.
        setState((prev) => ({
          ...prev,
          nftPdaAddress: pdaStr,
          isLoading: prev.nftPdaAddress === null,
        }));

        const accountInfo = await connection.getAccountInfo(nftPda);

        if (cancelled) return;

        if (!accountInfo || !accountInfo.data || accountInfo.data.length < POSITION_NFT_STATE_LEN) {
          setState({
            hasMintedNft: false,
            nftMint: null,
            pendingSettlement: false,
            nftPdaAddress: pdaStr,
            isLoading: false,
          });
          return;
        }

        const { mint, positionSize } = parsePositionNftAccount(
          Buffer.from(accountInfo.data)
        );

        setState({
          hasMintedNft: true,
          nftMint: mint,
          // No dedicated `pending_settlement` byte in the 208-byte layout.
          // Derive it from the snapshot: a PositionNft PDA with zero
          // position_size is one where the underlying trade has been
          // closed on-chain — the NFT is waiting to be burned.
          pendingSettlement: positionSize === 0n,
          nftPdaAddress: pdaStr,
          isLoading: false,
        });
      } catch (e) {
        console.error("[usePositionNft] Error fetching PDA:", e);
        if (!cancelled) {
          setState({
            hasMintedNft: false,
            nftMint: null,
            pendingSettlement: false,
            nftPdaAddress: null,
            isLoading: false,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Deliberately excluding `connection` — it's from context and stable in
    // practice; including the object reference was part of the flicker bug.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userIdx, programIdStr, slabAddress, mockMode]);

  return state;
}
