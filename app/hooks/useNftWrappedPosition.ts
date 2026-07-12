"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import { parsePositionNftAccount, parsePortfolioV17, isV17Account } from "@percolatorct/sdk";
import { portfolioV17ToAccount, triggerHeldNftScan, type UserAccountInfo } from "@/lib/userAccountScan";

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
        //    Shared scan — byte-for-byte the same query usePositionNft's
        //    held-NFT fallback runs, joined here rather than fired
        //    independently (lib/userAccountScan.ts). Also keeps last-good on
        //    a transient RPC error instead of resolving to an empty array,
        //    so a blip can't make an active wrapped position vanish.
        const nfts = await triggerHeldNftScan({
          connection,
          nftProgramId: PERCOLATOR_NFT_PROGRAM_ID,
          wallet: publicKey,
          raw: raw!,
        });
        if (cancelled) return;

        // 2. Parse every held NFT up front (cheap, synchronous), then batch-
        //    fetch all their wrapped portfolios in ONE getMultipleAccountsInfo
        //    call instead of a serial getAccountInfo per NFT.
        const parsedNfts: Array<{
          pubkey: PublicKey;
          nftMint: PublicKey;
          portfolioAccount: PublicKey;
        }> = [];
        for (const nft of nfts) {
          try {
            const parsed = parsePositionNftAccount(nft.data);
            parsedNfts.push({ pubkey: nft.pubkey, nftMint: parsed.nftMint, portfolioAccount: parsed.portfolioAccount });
          } catch {
            continue;
          }
        }

        if (parsedNfts.length === 0) {
          setWrapped(null);
          return;
        }

        const pfInfos = await connection.getMultipleAccountsInfo(parsedNfts.map((p) => p.portfolioAccount));
        if (cancelled) return;

        // 3. Keep the one on THIS market that still has an active leg (a
        //    closed-but-unburned NFT wraps a size-0 leg).
        for (let i = 0; i < parsedNfts.length; i++) {
          const pfInfo = pfInfos[i];
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
              nftMint: parsedNfts[i].nftMint,
              nftPda: parsedNfts[i].pubkey,
            });
            return;
          }
        }
        setWrapped(null);
      } catch (e) {
        // Keep-last-good: a transient error (RPC 429, timeout) here used to
        // null out `wrapped` unconditionally — making an actively-wrapped
        // position vanish from the dock on a single blip. Keep whatever was
        // last successfully determined; only the successful "found nothing on
        // this market" paths above (`setWrapped(null)`) are allowed to clear it.
        console.debug("[useNftWrappedPosition] scan failed, keeping last-good state:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, isV17Market, publicKey?.toBase58(), slabAddress, raw]);

  return enabled ? wrapped : null;
}
