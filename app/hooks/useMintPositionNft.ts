"use client";

import { useState, useCallback } from "react";
import { PublicKey, Keypair, TransactionInstruction, SYSVAR_RENT_PUBKEY, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useSlabState } from "@/components/providers/SlabProvider";
import { sendTx } from "@/lib/tx";
import { humanizeError } from "@/lib/errorMessages";
import { useToast } from "@/hooks/useToast";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";
import {
  deriveNftPda,
  deriveMintAuthority,
  deriveExtraAccountMetas,
  deriveNftRegistry,
  encodeNftMint,
  parsePortfolioV17,
  isV17Account,
} from "@percolatorct/sdk";

export function useMintPositionNft(slabAddress: string) {
  const { publicKey: walletPubkey } = useWalletCompat();
  const wallet = useWalletCompat();
  const { connection } = useConnectionCompat();
  const { programId, raw, refresh } = useSlabState();
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mint = useCallback(async () => {
    if (!walletPubkey || !programId) {
      setError("Wallet not connected or market not loaded");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const slabPk = new PublicKey(slabAddress);
      const nftProgId = PERCOLATOR_NFT_PROGRAM_ID;
      const isV17 = raw != null && raw.length > 0 && isV17Account(raw);

      // ── Find the user's portfolio and active leg ──────────────────────────
      // v17: portfolio is a standalone account; we need the marketId from the
      // active leg to derive the correct NFT PDA seeds:
      //   ["position_nft", portfolioPubkey, marketId_u64_LE]
      // The portfolio is discovered via getProgramAccounts filtered by magic +
      // market_group_id + owner (same filter as useTrade findV17Portfolio).
      const V17_PORTFOLIO_MAGIC = Buffer.from([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50]);
      const PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF = 16;
      // Mutable owner (SDK PF_OWNER_OFF) sits at offset 116, NOT provenance
      // offset 80 (IMMUTABLE, set at creation). MintPositionNft moves the
      // mutable owner to the escrow PDA on wrap but leaves provenance pointing
      // at the original wallet, so filtering on 80 would ALSO match an
      // already-wrapped/escrowed portfolio here. With one wrapped + one fresh
      // portfolio on this market, the @80 filter returns both and picking
      // allPortfolios[0] non-deterministically can target the already-minted
      // portfolio, failing pre-send simulation and intermittently blocking
      // mint of the genuinely-open position (mirrors useDeposit/usePositionNft).
      const PORTFOLIO_OWNER_OFF = 116;

      let portfolioPk: PublicKey;
      let marketId: bigint;

      if (isV17) {
        const allPortfolios = await connection.getProgramAccounts(programId, {
          filters: [
            { memcmp: { offset: 0, bytes: V17_PORTFOLIO_MAGIC.toString("base64"), encoding: "base64" } },
            { memcmp: { offset: PORTFOLIO_PROVENANCE_MARKET_GROUP_OFF, bytes: slabPk.toBase58() } },
            { memcmp: { offset: PORTFOLIO_OWNER_OFF, bytes: walletPubkey.toBase58() } },
          ],
        });
        if (allPortfolios.length === 0) {
          throw new Error("No portfolio found for your wallet on this market. Deposit collateral first.");
        }
        // Defense-in-depth: re-verify the mutable owner actually matches after
        // fetch — memcmp filters are advisory server-side; don't trust them
        // blindly (mirrors useDeposit/usePositionNft's re-verify).
        const pf = parsePortfolioV17(new Uint8Array(allPortfolios[0].account.data));
        if (!pf.owner.equals(walletPubkey)) {
          throw new Error("No portfolio found for your wallet on this market. Deposit collateral first.");
        }
        portfolioPk = allPortfolios[0].pubkey;
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

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
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

      // Send — skipPreflight since we already simulated above
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: true,
        maxRetries: 5,
      });

      // Wait for confirmation with blockhash-based expiry
      await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

      // Force an immediate slab re-poll so useUserAccount/usePositionNft re-scan
      // and the UI reflects the just-minted NFT without waiting for the next
      // poll cycle (closes the stale-window double-mint hazard).
      refresh();

      toast("Position NFT minted!", "success");
      return sig;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      const msg = humanizeError(errMsg);
      console.error("[useMintPositionNft]", errMsg);
      setError(msg);
      toast(msg, "error");
    } finally {
      setLoading(false);
    }
  }, [walletPubkey, programId, raw, slabAddress, connection, wallet, toast, refresh]);

  return { mint, loading, error };
}
