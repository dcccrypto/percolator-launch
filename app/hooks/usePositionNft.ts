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
import {
  triggerPortfolioScan,
  triggerHeldNftScan,
  type OwnPortfolioScanResult,
} from "@/lib/userAccountScan";

// Minimum byte length accepted by the v17 (SDK) NFT account parser.
const POSITION_NFT_STATE_LEN_V17 = 199;

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
          // 1. Find the user's portfolio via the SHARED portfolio scan store
          //    (magic + market_group + owner) — byte-for-byte the same query
          //    useUserAccount runs, so this joins that scan instead of firing
          //    a second identical getProgramAccounts call (see
          //    lib/userAccountScan.ts's header for the dedup mechanism).
          // 2. Read the active leg's marketId from the (already-parsed,
          //    already owner-reverified, already M10-sorted) shared result.
          // 3. Derive PDA with SDK seeds: ["position_nft", portfolio, marketId_u64_LE].
          // 4. Fetch the PDA account and parse with SDK parser (199 bytes).
          setState((prev) => ({ ...prev, isLoading: prev.nftPdaAddress === null }));

          const ownerWalletPk = new PublicKey(walletPubkeyStr!);
          const scanResult: OwnPortfolioScanResult | null = await triggerPortfolioScan({
            connection,
            programId,
            slabAddress,
            publicKey: ownerWalletPk,
            raw: raw!,
          });

          if (cancelled) return;

          // If the wallet currently owns (mutable owner@116) a portfolio here WITH
          // an active leg, it has a normal, unwrapped, currently-open position —
          // resolve the NFT PDA for it directly (this is the only case where a
          // fresh mint even makes sense). A wrapped portfolio's owner has moved to
          // the escrow PDA, so it no longer matches this scan — the held-NFT scan
          // below (last_holder@167) is what finds those.
          //
          // IMPORTANT: do NOT treat "scanResult === null" as the only trigger
          // for the held-NFT fallback below. A wallet can ALSO own a portfolio
          // here with NO active leg (e.g. a stale/closed position, or simply
          // one it deposited into without ever trading), or own an active leg
          // here with no self-minted NFT of its own, while SEPARATELY holding a
          // Position NFT — either self-minted-and-not-yet-transferred, or
          // received via transfer from someone else (whose escrowed portfolio
          // is a totally different account). The old code returned early the
          // moment the wallet had its own active leg (regardless of whether that
          // leg had a minted NFT), WITHOUT ever checking whether the wallet holds
          // a DIFFERENT NFT — that was the bug behind "received NFT shows Not
          // Minted / Burn disabled" for a wallet that also has its own open
          // position on the same market.
          let ownPortfolioPk: PublicKey | null = null;
          let ownActiveLeg: ReturnType<typeof parsePortfolioV17>["legs"][number] | null = null;
          if (scanResult) {
            // The shared scan already re-verified owner==wallet (a null result
            // means either no match or a failed re-verify), so only the
            // active-leg check remains.
            const activeLeg = scanResult.portfolio.legs.find((l) => l.active);
            if (activeLeg) {
              ownPortfolioPk = scanResult.pubkey;
              ownActiveLeg = activeLeg;
            }
          }

          // Remember the own-leg NFT PDA (if resolvable) so the final "not minted"
          // fallback below can still surface the right PDA address for Mint.
          let ownNftPdaStr: string | null = null;

          if (ownPortfolioPk && ownActiveLeg) {
            const [nftPda] = deriveNftPdaV17(ownPortfolioPk, ownActiveLeg.marketId, PERCOLATOR_NFT_PROGRAM_ID);
            ownNftPdaStr = nftPda.toBase58();

            setState((prev) => ({ ...prev, nftPdaAddress: ownNftPdaStr }));

            const accountInfo = await connection.getAccountInfo(nftPda);

            if (cancelled) return;

            if (accountInfo && accountInfo.data.length >= POSITION_NFT_STATE_LEN_V17) {
              const parsed = parsePositionNftAccountSdk(new Uint8Array(accountInfo.data));

              setState({
                hasMintedNft: true,
                nftMint: parsed.nftMint,
                // BUG 20: basisPosQAtMint is an immutable mint-time snapshot (always
                // non-zero — you can't mint an NFT for a zero position), so it can
                // never reflect the leg later going to size 0. Use the CURRENT
                // leg's basisPosQ (mirrors the fallback branch below).
                pendingSettlement: ownActiveLeg.basisPosQ === 0n,
                nftPdaAddress: ownNftPdaStr,
                isLoading: false,
              });
              return;
            }
            // No self-minted NFT for the own active leg — BUG 11: do NOT return
            // "not minted" yet. The wallet may still hold a Position NFT received
            // via transfer from someone else (a different escrowed portfolio
            // entirely) — fall through to the last_holder scan below instead of
            // early-returning here.
          }

          // Reached when the wallet has no self-minted NFT to show yet — either
          // it has no own unwrapped active-leg portfolio on this market at all
          // (never traded here, or only owns some other leg-less portfolio), or
          // (BUG 11) it DOES have its own active leg but hasn't minted an NFT for
          // it. Fall back to the NFT the wallet still holds — scan PositionNft
          // accounts by last_holder (offset 167) == wallet, then keep the one
          // whose wrapped portfolio (portfolio_account @10) is on this market.
          // This keeps Burn / Send / status working both right after a self-mint
          // and after receiving a transferred NFT (mirrors
          // useNftWrappedPosition, which uses the identical last_holder scan).
          // Shared scan — byte-for-byte the same query useNftWrappedPosition
          // runs (dataSize=199 + last_holder@167==wallet), joined here rather
          // than fired independently (lib/userAccountScan.ts).
          const heldNfts = await triggerHeldNftScan({
            connection,
            nftProgramId: PERCOLATOR_NFT_PROGRAM_ID,
            wallet: ownerWalletPk,
            raw: raw!,
          });
          if (cancelled) return;

          // Parse every held NFT (cheap, synchronous) up front, then batch-
          // fetch all their wrapped portfolios in ONE getMultipleAccountsInfo
          // call instead of a serial getAccountInfo per NFT (was N round-trips
          // for N held NFTs; typically small N, but each round-trip is a full
          // RPC hop).
          const parsedHeldNfts: Array<{
            pubkey: PublicKey;
            nftMint: PublicKey;
            portfolioAccount: PublicKey;
          }> = [];
          for (const heldNft of heldNfts) {
            try {
              const parsedNft = parsePositionNftAccountSdk(heldNft.data);
              parsedHeldNfts.push({
                pubkey: heldNft.pubkey,
                nftMint: parsedNft.nftMint,
                portfolioAccount: parsedNft.portfolioAccount,
              });
            } catch {
              continue;
            }
          }

          if (parsedHeldNfts.length > 0) {
            const wrappedInfos = await connection.getMultipleAccountsInfo(
              parsedHeldNfts.map((p) => p.portfolioAccount),
            );
            if (cancelled) return;

            for (let i = 0; i < parsedHeldNfts.length; i++) {
              const wrappedPfInfo = wrappedInfos[i];
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
                nftMint: parsedHeldNfts[i].nftMint,
                // No active (non-zero) leg ⇒ closed-but-unburned ⇒ burn to reclaim.
                pendingSettlement: !wrappedLeg || wrappedLeg.basisPosQ === 0n,
                nftPdaAddress: parsedHeldNfts[i].pubkey.toBase58(),
                isLoading: false,
              });
              return;
            }
          }
          setState({
            hasMintedNft: false,
            nftMint: null,
            pendingSettlement: false,
            nftPdaAddress: ownNftPdaStr ?? (scanResult ? scanResult.pubkey.toBase58() : null),
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
        // Keep-last-good: a transient error (RPC 429, timeout) here used to
        // reset the WHOLE state to "Not minted" — for an already-minted NFT
        // that's actively dangerous, not just a flicker: it re-enables the
        // Mint button and can invite a doomed re-mint attempt on an already-
        // wrapped position. Keep whatever was last successfully determined
        // and just clear the loading spinner; only an actually-SUCCESSFUL
        // scan (the setState calls above) is allowed to report "not minted".
        console.debug("[usePositionNft] Error fetching PDA, keeping last-good state:", e);
        if (!cancelled) {
          setState((prev) => ({ ...prev, isLoading: false }));
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
