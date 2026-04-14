"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUserAccount } from "@/hooks/useUserAccount";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";

const textEncoder = new TextEncoder();

// NFT program ID — separate from wrapper program
const NFT_PROGRAM_ID = new PublicKey("FqhKJT9gtScjrmfUuRMjeg7cXNpif1fqsy5Jh65tJmTS");

/**
 * Derive the position_nft PDA for a user account.
 * Seeds: ["position_nft", slab_key, user_idx as u16 LE]
 * Uses the NFT program ID, not the wrapper program.
 */
function derivePositionNftPda(
  slab: PublicKey,
  userIdx: number
): [PublicKey, number] {
  const idxBuf = new Uint8Array(2);
  new DataView(idxBuf.buffer).setUint16(0, userIdx, true);
  return PublicKey.findProgramAddressSync(
    [textEncoder.encode("position_nft"), slab.toBytes(), idxBuf],
    NFT_PROGRAM_ID
  );
}

// PositionNft account layout (208 bytes):
//   [0..8]    magic       u64
//   [8]       version     u8
//   [9]       bump        u8
//   [10..16]  _pad0       [u8; 6]
//   [16..48]  slab        [u8; 32]
//   [48..50]  user_idx    u16 LE
//   [50..56]  _pad1       [u8; 6]
//   [56..88]  nft_mint    [u8; 32]
//   [88..96]  entry_price u64
//   ...
const POSITION_NFT_SIZE = 208;

function parsePositionNftAccount(data: Buffer): {
  mint: PublicKey;
  pendingSettlement: boolean;
} {
  if (data.length < POSITION_NFT_SIZE) {
    throw new Error(`PositionNft account too small: ${data.length} < ${POSITION_NFT_SIZE}`);
  }
  const mint = new PublicKey(data.slice(56, 88)); // nft_mint at offset 56
  // No pending_settlement field in v12.15 layout — default to false
  const pendingSettlement = false;
  return { mint, pendingSettlement };
}
import {
  deriveNftPda,
  parsePositionNftAccount,
  POSITION_NFT_STATE_LEN,
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
        const [nftPda] = derivePositionNftPda(slabPk, userAccount.idx);
        const [nftPda] = deriveNftPda(slabPk, userAccount.idx, slabProgramId);
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
