"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnectionCompat, useWalletCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { useUserAccount } from "@/hooks/useUserAccount";
import { isMockMode } from "@/lib/mock-mode";
import { isMockSlab } from "@/lib/mock-trade-data";
import {
  PERCOLATOR_NFT_PROGRAM_ID,
  deriveNftPda as deriveNftPdaV12,
  parsePositionNftAccount as parsePositionNftAccountLib,
  POSITION_NFT_STATE_LEN as POSITION_NFT_STATE_LEN_V12,
} from "@/lib/nft-program";
import {
  deriveNftPda as deriveNftPdaV17,
  parsePositionNftAccount as parsePositionNftAccountSdk,
  parsePortfolioV17,
  isV17Account,
} from "@percolatorct/sdk";

// Minimum byte length accepted by the v17 (SDK) NFT account parser.
const POSITION_NFT_STATE_LEN_V17 = 199;

// v17 portfolio magic bytes for getProgramAccounts filter.
const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);

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
 * v17 markets (isV17Account(raw)):
 *   PDA seeds: ["position_nft", portfolioAccount, marketId_u64_LE]
 *   Layout: SDK parsePositionNftAccount (199 bytes, nftMint at offset 42)
 *
 * v12 markets (fallback):
 *   PDA seeds: ["position_nft", slab, user_idx_u16_LE]
 *   Layout: lib parsePositionNftAccount (208 bytes, mint at offset 56)
 */
export function usePositionNft(slabAddress: string): UsePositionNftResult {
  const { connection } = useConnectionCompat();
  const { publicKey: walletPubkey } = useWalletCompat();
  const userAccount = useUserAccount();
  const { programId: slabProgramId, raw } = useSlabState();
  const mockMode = isMockMode() && isMockSlab(slabAddress);

  const [state, setState] = useState<UsePositionNftResult>({
    hasMintedNft: false,
    nftMint: null,
    pendingSettlement: false,
    nftPdaAddress: null,
    isLoading: false,
  });

  // Stabilise effect deps with primitives so the effect doesn't re-run on
  // every slab poll (~2s). The NFT PDA only changes when identity (program,
  // slab, user) changes.
  const userIdx = userAccount?.idx ?? null;
  const programIdStr = slabProgramId?.toBase58() ?? null;
  const walletPubkeyStr = walletPubkey?.toBase58() ?? null;
  const isV17 = raw != null && raw.length > 0 && isV17Account(raw);

  useEffect(() => {
    // For v17 we need wallet pubkey; for v12 we need userIdx.
    const needsV12 = !isV17 && userIdx === null;
    const needsV17 = isV17 && walletPubkeyStr === null;
    if (!programIdStr || !slabAddress || needsV12 || needsV17) {
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
        const programId = new PublicKey(programIdStr);

        if (mockMode) {
          if (!cancelled) {
            setState({
              hasMintedNft: false,
              nftMint: null,
              pendingSettlement: false,
              nftPdaAddress: null,
              isLoading: false,
            });
          }
          return;
        }

        if (isV17) {
          // ── v17 path ─────────────────────────────────────────────────────
          // 1. Find the user's portfolio via getProgramAccounts (magic + market_group + owner).
          // 2. Parse the portfolio to get the active leg's marketId.
          // 3. Derive PDA with SDK seeds: ["position_nft", portfolio, marketId_u64_LE].
          // 4. Fetch the PDA account and parse with SDK parser (199 bytes).
          setState((prev) => ({ ...prev, isLoading: prev.nftPdaAddress === null }));

          const allPortfolios = await connection.getProgramAccounts(programId, {
            filters: [
              { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
              // market_group_id sits at provenance offset 16 (after 8-byte header)
              { memcmp: { offset: 16, bytes: slabPk.toBase58() } },
              // portfolio owner sits at provenance offset 80
              { memcmp: { offset: 80, bytes: walletPubkeyStr! } },
            ],
          });

          if (cancelled) return;

          // If the wallet owns a portfolio here (by provenance) WITH an active
          // leg, it has a normal, unwrapped, currently-open position — resolve
          // the NFT PDA for it directly (this is the only case where a fresh
          // mint even makes sense).
          //
          // IMPORTANT: do NOT treat "allPortfolios.length === 0" as the only
          // trigger for the held-NFT fallback below. A wallet can ALSO own a
          // portfolio here with NO active leg (e.g. a stale/closed position,
          // or simply one it deposited into without ever trading) while
          // SEPARATELY holding a Position NFT — either self-minted-and-not-
          // yet-transferred, or received via transfer from someone else (whose
          // escrowed portfolio is a totally different account). The old code
          // returned "not minted" the moment allPortfolios[0] had no active
          // leg, WITHOUT ever checking whether the wallet holds an NFT — that
          // was the bug behind "received NFT shows Not Minted / Burn disabled"
          // even though useNftWrappedPosition (which unconditionally scans by
          // last_holder) found it just fine.
          let ownPortfolioPk: PublicKey | null = null;
          let ownActiveLeg: ReturnType<typeof parsePortfolioV17>["legs"][number] | null = null;
          if (allPortfolios.length > 0) {
            const pf = parsePortfolioV17(new Uint8Array(allPortfolios[0].account.data));
            const activeLeg = pf.legs.find((l) => l.active);
            if (activeLeg) {
              ownPortfolioPk = allPortfolios[0].pubkey;
              ownActiveLeg = activeLeg;
            }
          }

          if (ownPortfolioPk && ownActiveLeg) {
            const [nftPda] = deriveNftPdaV17(ownPortfolioPk, ownActiveLeg.marketId, PERCOLATOR_NFT_PROGRAM_ID);
            const pdaStr = nftPda.toBase58();

            setState((prev) => ({ ...prev, nftPdaAddress: pdaStr }));

            const accountInfo = await connection.getAccountInfo(nftPda);

            if (cancelled) return;

            if (!accountInfo || accountInfo.data.length < POSITION_NFT_STATE_LEN_V17) {
              setState({
                hasMintedNft: false,
                nftMint: null,
                pendingSettlement: false,
                nftPdaAddress: pdaStr,
                isLoading: false,
              });
              return;
            }

            const parsed = parsePositionNftAccountSdk(new Uint8Array(accountInfo.data));

            setState({
              hasMintedNft: true,
              nftMint: parsed.nftMint,
              // positionSize === 0 means position closed but NFT not yet burned.
              pendingSettlement: parsed.basisPosQAtMint === 0n,
              nftPdaAddress: pdaStr,
              isLoading: false,
            });
            return;
          }

          // Reached when the wallet has no OWN unwrapped active-leg portfolio
          // on this market — either it never traded here directly, or (the bug
          // fixed above) it owns some other leg-less portfolio here. Fall back
          // to the NFT the wallet still holds — scan PositionNft accounts by
          // last_holder (offset 167) == wallet, then keep the one whose
          // wrapped portfolio (portfolio_account @10) is on this market. This
          // keeps Burn / Send / status working both right after a self-mint
          // and after receiving a transferred NFT (mirrors
          // useNftWrappedPosition, which uses the identical last_holder scan).
          const heldNfts = await connection.getProgramAccounts(PERCOLATOR_NFT_PROGRAM_ID, {
            filters: [
              { dataSize: POSITION_NFT_STATE_LEN_V17 },
              { memcmp: { offset: 167, bytes: walletPubkeyStr! } },
            ],
          });
          if (cancelled) return;
          for (const heldNft of heldNfts) {
            let parsedNft;
            try {
              parsedNft = parsePositionNftAccountSdk(new Uint8Array(heldNft.account.data));
            } catch {
              continue;
            }
            const wrappedPfInfo = await connection.getAccountInfo(parsedNft.portfolioAccount);
            if (cancelled) return;
            if (!wrappedPfInfo) continue;
            let wrappedPf;
            try {
              wrappedPf = parsePortfolioV17(new Uint8Array(wrappedPfInfo.data));
            } catch {
              continue;
            }
            if (!(wrappedPf.marketGroupId?.equals(slabPk) ?? false)) continue;
            const wrappedLeg = wrappedPf.legs.find((l) => l.active);
            setState({
              hasMintedNft: true,
              nftMint: parsedNft.nftMint,
              // No active (non-zero) leg ⇒ closed-but-unburned ⇒ burn to reclaim.
              pendingSettlement: !wrappedLeg || wrappedLeg.basisPosQ === 0n,
              nftPdaAddress: heldNft.pubkey.toBase58(),
              isLoading: false,
            });
            return;
          }
          setState({
            hasMintedNft: false,
            nftMint: null,
            pendingSettlement: false,
            nftPdaAddress: allPortfolios.length > 0 ? allPortfolios[0].pubkey.toBase58() : null,
            isLoading: false,
          });

        } else {
          // ── v12 path ─────────────────────────────────────────────────────
          // PDA seeds: ["position_nft", slab, userIdx_u16_LE]
          // Layout: lib parsePositionNftAccount (208 bytes)
          const [nftPda] = deriveNftPdaV12(slabPk, userIdx!, PERCOLATOR_NFT_PROGRAM_ID);
          const pdaStr = nftPda.toBase58();

          setState((prev) => ({
            ...prev,
            nftPdaAddress: pdaStr,
            isLoading: prev.nftPdaAddress === null,
          }));

          const accountInfo = await connection.getAccountInfo(nftPda);

          if (cancelled) return;

          if (!accountInfo || accountInfo.data.length < POSITION_NFT_STATE_LEN_V12) {
            setState({
              hasMintedNft: false,
              nftMint: null,
              pendingSettlement: false,
              nftPdaAddress: pdaStr,
              isLoading: false,
            });
            return;
          }

          const { mint, positionSize } = parsePositionNftAccountLib(
            Buffer.from(accountInfo.data)
          );

          setState({
            hasMintedNft: true,
            nftMint: mint,
            pendingSettlement: positionSize === 0n,
            nftPdaAddress: pdaStr,
            isLoading: false,
          });
        }
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
    // Deliberately excluding `connection` — object ref recreated on every poll.
    // `raw` IS included so the NFT status re-scans on every slab update — after a
    // mint/transfer/burn the portfolio is escrowed (owner != wallet), so `userIdx`
    // stays null and would never re-trigger this effect on its own; without `raw`
    // the panel showed stale "Minted/Active" after a Send and let the user re-click
    // Send/Burn into a failing tx (mirrors useUserAccount / useNftWrappedPosition,
    // which both key off `raw`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isV17, walletPubkeyStr, userIdx, programIdStr, slabAddress, mockMode, raw]);

  return state;
}
