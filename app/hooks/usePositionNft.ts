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

  useEffect(() => {
    if (!userAccount || !slabProgramId || !slabAddress) {
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
        const [nftPda] = deriveNftPda(slabPk, userAccount.idx, PERCOLATOR_NFT_PROGRAM_ID);
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

        setState((prev) => ({ ...prev, isLoading: true, nftPdaAddress: pdaStr }));

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

        const { mint, pendingSettlement } = parsePositionNftAccount(
          Buffer.from(accountInfo.data)
        );

        setState({
          hasMintedNft: true,
          nftMint: mint,
          pendingSettlement,
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
  }, [userAccount, slabProgramId, slabAddress, mockMode, connection]);

  return state;
}
