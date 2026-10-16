"use client";

import { errorText } from "@/lib/error-text";
import { useState, useCallback } from "react";
import { PublicKey, Keypair, TransactionInstruction, SYSVAR_RENT_PUBKEY, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { broadcastSignedTx } from "@/lib/tx";
import { humanizeError } from "@/lib/errorMessages";
import { plainMessage } from "@/lib/limits/user-message";
import { useToast } from "@/hooks/useToast";
import { isPortfolioTargetError, PortfolioTargetError, TARGET_COPY, verifyPortfolioTarget } from "@/lib/portfolio-target";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import {
  deriveNftPda,
  deriveMintAuthority,
  deriveExtraAccountMetas,
  deriveNftRegistry,
  encodeNftMint,
} from "@percolatorct/sdk";
import { parsePortfolio, isWrapperAccount } from "@/lib/v22/layout";
import { noteBlockhash } from "@/lib/v22/sign-guard";

export function useMintPositionNft(slabAddress: string) {
  const { publicKey: walletPubkey } = useWalletCompat();
  const wallet = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { programId, raw, refresh } = useSlabState();
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** `portfolioPk`: the account the row and the wrap sheet show (#3301 pattern). Never re-picked here. */
  const mint = useCallback(async (portfolioPk: PublicKey) => {
    if (!walletPubkey || !programId) {
      setError("Wallet not connected or market not loaded");
      return;
    }
    setLoading(true);
    setError(null);

    try {
      // Defense-in-depth parity with useTrade/useDeposit/useWithdraw: these
      // NFT hooks derive PDAs from `programId` (useSlabState) and use it as an
      // account, but relied solely on SlabProvider nulling programId for an
      // unknown-owner slab. Assert it's a known program before building a
      // signable tx, so a phishing slab can never reach the tx-build path.
      // Inside the try so the existing catch surfaces it like any other error.
      assertKnownProgram(programId);

      const slabPk = new PublicKey(slabAddress);
      const nftProgId = PERCOLATOR_NFT_PROGRAM_ID;
      const isV17 = raw != null && raw.length > 0 && isWrapperAccount(raw);

      // ── The portfolio the row shows, and its active leg ──────────────────
      // v17: the NFT PDA seeds are ["position_nft", portfolioPubkey, marketId_u64_LE], marketId from the
      // active leg. A wallet can own several portfolios on one market (wrap, trade again, unwrap), so
      // this wraps exactly the account the caller named (the row's) and never re-discovers one: a
      // getProgramAccounts pick in RPC order could escrow a position the user didn't choose.
      let marketId: bigint;

      if (isV17) {
        if (!portfolioPk) throw new PortfolioTargetError(TARGET_COPY.unmatched);
        const info = await connection.getAccountInfo(portfolioPk, "confirmed");
        const pf = parsePortfolio(new Uint8Array(verifyPortfolioTarget(info, programId, slabPk, walletPubkey)));
        const activeLeg = pf.legs.find((l) => l.active);
        if (!activeLeg) {
          throw new Error("No active position to mint an NFT for. Open a position first.");
        }
        marketId = activeLeg.marketId;
      } else {
        // v12: NFT PDA seeds are ["position_nft", slab, userIdx_u16_LE]
        // Fall back to the old approach for non-v17 markets — userAccount.idx
        // is available only via useUserAccount which is no longer imported.
        // v12 markets are not in scope for v17 NFT; surface a clear error.
        throw new Error("Position NFT minting is only supported on v17 markets.");
      }

      // v17: derive NFT PDA with correct seeds (portfolio + marketId_u64_LE)
      const [nftPda] = deriveNftPda(portfolioPk, marketId, nftProgId);
      // nft_mint is a fresh keypair (not a PDA)
      const nftMintKeypair = Keypair.generate();
      const nftMint = nftMintKeypair.publicKey;

      // PDAs
      const [mintAuth]   = deriveMintAuthority(nftProgId);
      const [extraMetas] = deriveExtraAccountMetas(nftMint, nftProgId);
      const [nftRegistry] = deriveNftRegistry(programId, slabPk);

      // Owner's Token-2022 ATA for the NFT mint
      const ownerAta = getAssociatedTokenAddressSync(
        nftMint,
        walletPubkey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );

      // MintPositionNft — 12 accounts (v17):
      //  [0] owner           signer+writable
      //  [1] nft_pda         writable
      //  [2] nft_mint        signer+writable (fresh keypair)
      //  [3] owner_ata       writable
      //  [4] portfolio       writable  ← was incorrectly slab read-only
      //  [5] mint_authority  readonly
      //  [6] token-2022      readonly
      //  [7] ata_program     readonly
      //  [8] system          readonly
      //  [9] extra_metas     writable
      // [10] nft_registry    readonly  ← was missing
      // [11] wrapper_program readonly  ← was missing
      const ix = new TransactionInstruction({
        programId: nftProgId,
        keys: [
          { pubkey: walletPubkey,              isSigner: true,  isWritable: true  }, // 0: owner
          { pubkey: nftPda,                    isSigner: false, isWritable: true  }, // 1: nft_pda
          { pubkey: nftMint,                   isSigner: true,  isWritable: true  }, // 2: nft_mint
          { pubkey: ownerAta,                  isSigner: false, isWritable: true  }, // 3: owner_ata
          { pubkey: portfolioPk,               isSigner: false, isWritable: true  }, // 4: portfolio (writable)
          { pubkey: mintAuth,                  isSigner: false, isWritable: false }, // 5: mint_authority
          { pubkey: TOKEN_2022_PROGRAM_ID,     isSigner: false, isWritable: false }, // 6: token-2022
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 7: ata_program
          { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false }, // 8: system
          { pubkey: extraMetas,                isSigner: false, isWritable: true  }, // 9: extra_metas
          { pubkey: nftRegistry,               isSigner: false, isWritable: false }, // 10: nft_registry
          { pubkey: programId,                 isSigner: false, isWritable: false }, // 11: wrapper_program
        ],
        data: Buffer.from(encodeNftMint(0)), // assetIndex=0
      });

      // Build and sign manually — Privy embedded wallets can't handle extra
      // keypair signers through the standard sendTx flow. We:
      // 1. Build the tx with compute budget
      // 2. Simulate (unsigned) to catch program errors before the user signs
      // 3. Sign with the keypair first (partialSign)
      // 4. Send to Privy for wallet signature (signTransaction)
      // 5. Re-add the keypair signature (Privy may strip it)
      // 6. Send raw transaction ourselves
      const { ComputeBudgetProgram } = await import("@solana/web3.js");
      const tx = new (await import("@solana/web3.js")).Transaction();
      // MintPositionNft CPIs into the v17 wrapper, which installs a custom 128KB
      // heap allocator and aborts ("Access violation in heap section") on its first
      // heap allocation unless the tx requests the full heap frame. Must be the
      // FIRST instruction. (mirrors useTransferPositionNft.ts / lib/tx.ts, issue #176)
      tx.add(ComputeBudgetProgram.requestHeapFrame({ bytes: 131072 }));
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
      tx.add(ix);

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      noteBlockhash(blockhash, "useMintPositionNft", connection);
      tx.feePayer = walletPubkey;

      // LAUNCH-H3: Pre-send simulation — catch program errors before user signs.
      // We simulate without signatures (sigVerify:false) so both signers being
      // absent is not an issue. On simulation failure we surface a clear error
      // rather than a cryptic on-chain rejection.
      {
        const simResult = await connection.simulateTransaction(tx, undefined, true);
        if (simResult.value.err) {
          const logs = simResult.value.logs ?? [];
          const errorLog = logs
            .filter((l) => l.includes("Error") || l.includes("failed") || l.includes("Program log:"))
            .slice(-3)
            .join("\n");
          throw new Error(
            `NFT mint simulation failed: ${JSON.stringify(simResult.value.err)}` +
            (errorLog ? `\n${errorLog}` : "")
          );
        }
      }

      // Keypair signs first
      tx.partialSign(nftMintKeypair);

      // Wallet signs (Privy)
      if (!wallet.signTransaction) throw new Error("Wallet does not support signTransaction");
      const signed = await wallet.signTransaction(tx);

      // Privy may have stripped the keypair sig — re-add it
      signed.partialSign(nftMintKeypair);

      // Send (skipPreflight: simulated above) and confirm by polling the signature status, the
      // same path sendTx uses. Blockheight-bound confirmTransaction() throws "block height
      // exceeded" whenever its subscription misses the landing, with no final status check, and
      // that reads as "The network was slow. Nothing was sent." for a wrap that landed.
      // pollConfirmation still throws for a tx that landed and failed on-chain (#2994).
      const sig = await broadcastSignedTx(connection, signed, { skipPreflight: true });

      // Force an immediate slab re-poll so useUserAccount/usePositionNft re-scan
      // and the UI reflects the just-minted NFT without waiting for the next
      // poll cycle (closes the stale-window double-mint hazard).
      refresh();

      toast("Position NFT minted!", "success");
      return sig;
    } catch (e) {
      const errMsg = errorText(e);
      const msg = isPortfolioTargetError(e) ? e.message : plainMessage(errMsg, { surface: "nft" }, humanizeError);
      console.error("[useMintPositionNft]", errMsg);
      setError(msg);
      toast(msg, "error");
    } finally {
      setLoading(false);
    }
  }, [walletPubkey, programId, raw, slabAddress, connection, wallet, toast, refresh]);

  return { mint, loading, error };
}
