"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import { parsePositionNftAccount, parsePortfolioV17, isV17Account } from "@percolatorct/sdk";
import { portfolioV17ToAccount, type UserAccountInfo } from "@/hooks/useUserAccount";

// PositionNftV16 on-chain layout is exactly 199 bytes. `last_holder` — the
// NFT's current/most-recent holder wallet (set to the minter at mint, rewritten
// to the recipient on every transfer) — occupies bytes [167..199].
const POSITION_NFT_V17_LEN = 199;
const NFT_LAST_HOLDER_OFF = 167;

export interface NftWrappedPosition extends UserAccountInfo {
  /** The Token-2022 NFT mint that now escrows this position. */
  nftMint: PublicKey;
  /** The PositionNft state account (PDA). */
  nftPda: PublicKey;
}

/**
 * Find the wallet's position that has been WRAPPED (escrowed) into a Position
 * NFT on the current market.
 *
 * v17 `MintPositionNft` B-3-transfers `portfolio.owner` to the NFT program's
 * mint-authority PDA (the position is frozen-while-wrapped). `useUserAccount`
 * scans portfolios by `owner == wallet`, so after minting it can no longer find
 * the portfolio — the position "disappears" from the dock even though the wallet
 * still controls it via the NFT it holds.
 *
 * This hook finds it the only way still possible: scan the NFT program for a
 * `PositionNft` whose `last_holder` (offset 167) is this wallet, read the
 * `portfolio_account` (offset 10) it wraps, and load that escrowed portfolio for
 * full live data (size, capital, PnL) — identical to a normal position, just
 * owned by the escrow PDA rather than the wallet.
 *
 * `enabled` gates the scan so it does NOT fire when the wallet already has a
 * normal (un-wrapped) position — the common case pays zero extra RPC.
 */
export function useNftWrappedPosition(
  slabAddress: string,
  enabled: boolean,
): NftWrappedPosition | null {
  const { connection } = useConnectionCompat();
  const { publicKey } = useWalletCompat();
  const { raw } = useSlabState();
  const [wrapped, setWrapped] = useState<NftWrappedPosition | null>(null);

  const isV17Market = raw != null && raw.length > 0 && isV17Account(raw);

  useEffect(() => {
    if (!enabled || !isV17Market || !publicKey || !slabAddress) {
      setWrapped(null);
      return;
    }
    let cancelled = false;
    const slabPk = (() => {
      try {
        return new PublicKey(slabAddress);
      } catch {
        return null;
      }
    })();
    if (!slabPk) {
      setWrapped(null);
      return;
    }

    (async () => {
      try {
        // 1. Every PositionNft this wallet currently holds (last_holder == wallet).
        const nfts = await connection.getProgramAccounts(PERCOLATOR_NFT_PROGRAM_ID, {
          filters: [
            { dataSize: POSITION_NFT_V17_LEN },
            { memcmp: { offset: NFT_LAST_HOLDER_OFF, bytes: publicKey.toBase58() } },
          ],
        });
        if (cancelled) return;

        // 2. Load each wrapped portfolio; keep the one on THIS market that still
        //    has an active leg (a closed-but-unburned NFT wraps a size-0 leg).
        for (const nft of nfts) {
          let parsed;
          try {
            parsed = parsePositionNftAccount(new Uint8Array(nft.account.data as Buffer));
          } catch {
            continue;
          }
          const pfInfo = await connection.getAccountInfo(parsed.portfolioAccount);
          if (cancelled) return;
          if (!pfInfo) continue;
          let pf;
          try {
            pf = parsePortfolioV17(new Uint8Array(pfInfo.data));
          } catch {
            continue;
          }
          const onThisMarket = pf.marketGroupId?.equals(slabPk) ?? false;
          const activeLeg = pf.legs.find((l) => l.active);
          if (onThisMarket && activeLeg && activeLeg.basisPosQ !== 0n) {
            setWrapped({
              idx: 0,
              account: portfolioV17ToAccount(pf),
              nftMint: parsed.nftMint,
              nftPda: nft.pubkey,
            });
            return;
          }
        }
        setWrapped(null);
      } catch {
        if (!cancelled) setWrapped(null);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isV17Market, publicKey?.toBase58(), slabAddress, raw]);

  return enabled ? wrapped : null;
}
