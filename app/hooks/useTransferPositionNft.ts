"use client";

import { useState, useCallback } from "react";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  AccountMeta,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { useUserAccount } from "@/hooks/useUserAccount";
import { usePositionNft } from "@/hooks/usePositionNft";
import { humanizeError } from "@/lib/errorMessages";
import { useToast } from "@/hooks/useToast";
import { PERCOLATOR_NFT_PROGRAM_ID } from "@/lib/nft-program";

/**
 * Build the Token-2022 `TransferChecked` instruction byte-for-byte, using
 * only DataView (a browser standard) rather than Node's Buffer. Avoids
 * `Buffer.writeBigUInt64LE`, which Next.js's compiled buffer polyfill
 * does not ship — calling it crashes the entire Send NFT flow.
 *
 * Instruction data layout (SPL Token):
 *   [0]     = 12 (TransferChecked tag)
 *   [1..9]  = amount, u64 little-endian
 *   [9]     = decimals (u8)
 */
function buildTransferCheckedIx(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
  programId: PublicKey,
): TransactionInstruction {
  const data = new Uint8Array(10);
  const dv = new DataView(data.buffer);
  data[0] = 12; // TransferChecked
  dv.setBigUint64(1, amount, true);
  data[9] = decimals & 0xff;

  const keys: AccountMeta[] = [
    { pubkey: source, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: destination, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ];

  return new TransactionInstruction({
    programId,
    keys,
    // web3.js's TransactionInstruction types `data` as Buffer. The
    // bytes themselves came from a Uint8Array with DataView, so we
    // only pay the cast here — no BigInt methods needed on the Buffer.
    data: Buffer.from(data),
  });
}

/**
 * Parse an on-chain `ExtraAccountMetaList` account (written by
 * MintPositionNft / RepairExtraMetas) and return its entries in the same
 * order as the on-chain layout:
 *
 *   [0..8]   discriminator (spl-transfer-hook-interface:execute)
 *   [8..12]  tlv_value_len  u32 LE
 *   [12..16] entry_count    u32 LE
 *   [16..]   entry_count × 35 bytes:
 *              [0]      discriminator (0 = FixedPubkey)
 *              [1..33]  pubkey
 *              [33]     is_signer (u8)
 *              [34]     is_writable (u8)
 *
 * We only emit FixedPubkey entries on-chain, so any other discriminator
 * here means the PDA was written by a different program or is stale; we
 * surface that as an error instead of guessing.
 */
function parseExtraAccountMetas(raw: Uint8Array): AccountMeta[] {
  const MIN_LEN = 16;
  if (raw.length < MIN_LEN) {
    throw new Error(
      `ExtraAccountMetaList data too short (${raw.length} bytes). ` +
        `The NFT mint's metadata PDA is missing or corrupt — run RepairExtraMetas.`,
    );
  }
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const entryCount = dv.getUint32(12, true);
  const ENTRY_LEN = 35;
  const expectedLen = MIN_LEN + entryCount * ENTRY_LEN;
  if (raw.length < expectedLen) {
    throw new Error(
      `ExtraAccountMetaList truncated: have ${raw.length} bytes, ` +
        `need ${expectedLen} for ${entryCount} entries. Run RepairExtraMetas.`,
    );
  }
  const metas: AccountMeta[] = [];
  for (let i = 0; i < entryCount; i++) {
    const off = MIN_LEN + i * ENTRY_LEN;
    const disc = raw[off];
    if (disc !== 0) {
      throw new Error(
        `ExtraAccountMetaList entry ${i} uses unsupported discriminator ${disc}. ` +
          `Only FixedPubkey (0) entries are expected.`,
      );
    }
    const pubkey = new PublicKey(raw.slice(off + 1, off + 33));
    const isSigner = raw[off + 33] === 1;
    const isWritable = raw[off + 34] === 1;
    metas.push({ pubkey, isSigner, isWritable });
  }
  return metas;
}

function deriveExtraAccountMetasPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("extra-account-metas"), mint.toBytes()],
    PERCOLATOR_NFT_PROGRAM_ID,
  );
  return pda;
}

/**
 * Transfer a Position NFT to another wallet.
 *
 * This is a plain Token-2022 TransferChecked. The NFT mint has a TransferHook
 * extension pointing at percolator-nft, so the hook runs automatically inside
 * the same transaction and:
 *
 *   1. Rejects if the underlying position is below maintenance margin.
 *   2. Settles funding (records the current funding index on the PDA).
 *   3. CPIs into percolator-prog with `TransferOwnershipCpi` (tag 69), which
 *      changes `Account.owner` inside the slab from sender → destination.
 *
 * The frontend does not need to touch the slab directly. The hook sees the
 * amount+mint and does the rest, atomically.
 *
 * ExtraAccountMetaList resolution is handled by
 * `createTransferCheckedWithTransferHookInstruction` — it reads the
 * ExtraAccountMetaList PDA off-chain and appends the right extra accounts
 * (mint_auth, slab, percolator_prog, ...) to the ix. Without this helper we
 * would have to hand-roll that list and keep it in sync with
 * percolator-nft/src/processor.rs — not worth it.
 */
export function useTransferPositionNft(slabAddress: string) {
  const { publicKey: walletPubkey, signTransaction } = useWalletCompat();
  const { connection } = useConnectionCompat();
  const userAccount = useUserAccount();
  const { nftMint } = usePositionNft(slabAddress);
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transfer = useCallback(
    async (destinationWallet: PublicKey): Promise<string | null> => {
      setError(null);
      if (!walletPubkey || !userAccount || !nftMint) {
        setError("Wallet not connected, no position, or NFT not minted");
        return null;
      }
      if (!signTransaction) {
        setError("Wallet does not support signing");
        return null;
      }
      if (destinationWallet.equals(walletPubkey)) {
        setError("Destination must be a different wallet");
        return null;
      }

      setLoading(true);
      // Track which step we are in so an empty-message throw still gives
      // the user something actionable. Privy's wallet adapter and the
      // spl-token helpers both throw typed errors with blank .message
      // fields in several edge cases — without this tag, humanizeError
      // receives "" and falls through to a useless "Transaction failed:".
      let stage = "initializing";
      try {
        stage = "deriving ATAs";
        const sourceAta = getAssociatedTokenAddressSync(
          nftMint,
          walletPubkey,
          false,
          TOKEN_2022_PROGRAM_ID,
        );
        const destAta = getAssociatedTokenAddressSync(
          nftMint,
          destinationWallet,
          false,
          TOKEN_2022_PROGRAM_ID,
        );

        stage = "building destination ATA instruction";
        const createDestAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          walletPubkey,
          destAta,
          destinationWallet,
          nftMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        // Pre-flight the mint account fetch ourselves. spl-token's
        // `createTransferCheckedWithTransferHookInstruction` calls
        // `getMint(connection, mint, ...)` internally and throws
        // `TokenAccountNotFoundError` (with a blank `.message`) if the
        // account isn't on the connection's RPC. Doing the lookup here
        // turns that into a concrete error with the actual mint pubkey
        // + RPC endpoint, which is what users (and me) need to debug.
        stage = "verifying NFT mint exists on RPC";
        console.info("[useTransferPositionNft] mint:", nftMint.toBase58());
        const mintInfo = await connection.getAccountInfo(nftMint, "confirmed");
        if (!mintInfo) {
          throw new Error(
            `NFT mint ${nftMint.toBase58()} was not found on the connected RPC. ` +
              `This usually means the frontend is pointed at the wrong cluster ` +
              `(devnet vs mainnet) or the RPC is stale. Refresh the page; if it ` +
              `persists the wallet address may hold an NFT from a different market.`,
          );
        }
        if (!mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
          throw new Error(
            `NFT mint ${nftMint.toBase58()} is owned by ${mintInfo.owner.toBase58()}, ` +
              `not Token-2022. This shouldn't happen for a Percolator position NFT.`,
          );
        }

        // Build TransferChecked + the transfer-hook extras ourselves
        // instead of calling spl-token's
        // createTransferCheckedWithTransferHookInstruction. The helper
        // uses Buffer.writeBigUInt64LE internally — Next.js's compiled
        // buffer polyfill omits that method, so the helper crashes
        // before the ix is even built. Going direct with DataView +
        // reading the ExtraAccountMetaList PDA we wrote ourselves keeps
        // this codepath free of Buffer altogether.
        stage = "building TransferChecked instruction";
        const transferIx = buildTransferCheckedIx(
          sourceAta,
          nftMint,
          destAta,
          walletPubkey,
          1n,
          0,
          TOKEN_2022_PROGRAM_ID,
        );

        stage = "fetching ExtraAccountMetaList PDA";
        const extraMetasPda = deriveExtraAccountMetasPda(nftMint);
        const extraMetasInfo = await connection.getAccountInfo(extraMetasPda, "confirmed");
        if (!extraMetasInfo) {
          throw new Error(
            `ExtraAccountMetaList PDA ${extraMetasPda.toBase58()} not found. ` +
              `This NFT is missing its transfer-hook metadata — run the on-chain ` +
              `RepairExtraMetas instruction (tag 6) against mint ${nftMint.toBase58()}.`,
          );
        }
        if (!extraMetasInfo.owner.equals(PERCOLATOR_NFT_PROGRAM_ID)) {
          throw new Error(
            `ExtraAccountMetaList PDA owned by ${extraMetasInfo.owner.toBase58()}, ` +
              `expected ${PERCOLATOR_NFT_PROGRAM_ID.toBase58()}.`,
          );
        }

        stage = "appending transfer-hook extra accounts";
        const extraMetas = parseExtraAccountMetas(
          new Uint8Array(extraMetasInfo.data),
        );
        // Order must match spl-token's addExtraAccountMetasForExecute:
        //   [...base TransferChecked keys (source,mint,dest,owner)]
        //   [...extra accounts resolved from ExtraAccountMetaList]
        //   hook program id
        //   validate-state PDA
        // Token-2022 reads these off the tail of TransferChecked's keys
        // and passes them to Execute on the hook CPI.
        transferIx.keys.push(
          ...extraMetas,
          {
            pubkey: PERCOLATOR_NFT_PROGRAM_ID,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: extraMetasPda,
            isSigner: false,
            isWritable: false,
          },
        );

        stage = "assembling transaction";
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }));
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
        tx.add(createDestAtaIx);
        tx.add(transferIx);

        stage = "fetching blockhash";
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = walletPubkey;

        stage = "pre-flight simulation";
        {
          const sim = await connection.simulateTransaction(tx, undefined, true);
          if (sim.value.err) {
            const logs = sim.value.logs ?? [];
            const relevant = logs
              .filter((l) => l.includes("Program log:") || l.includes("failed"))
              .slice(-5)
              .join("\n");
            throw new Error(
              `NFT transfer simulation failed: ${JSON.stringify(sim.value.err)}` +
                (relevant ? `\n${relevant}` : ""),
            );
          }
        }

        stage = "waiting for wallet signature";
        const signed = await signTransaction(tx);

        stage = "submitting transaction";
        const sig = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: true,
          maxRetries: 5,
        });

        stage = "waiting for confirmation";
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed",
        );

        toast(`Position NFT sent to ${destinationWallet.toBase58().slice(0, 8)}…`, "success");
        return sig;
      } catch (e) {
        // Always log the raw error object so the browser console shows the
        // actual shape — not just .message, which is often empty for
        // wallet-adapter / spl-token typed errors.
        console.error("[useTransferPositionNft] stage:", stage, "error:", e);

        // Build a meaningful raw string even when .message is empty.
        let raw = "";
        if (e instanceof Error) {
          raw = e.message || e.name || e.constructor?.name || "";
        } else if (e != null) {
          raw = String(e);
        }
        if (!raw.trim()) {
          raw = `Failed while ${stage}. Check the browser console for the raw error object.`;
        }

        // User rejected wallet signature — surface a clean UX message and
        // do not treat it as an error state.
        if (/user (rejected|cancelled|denied)|rejected the request/i.test(raw)) {
          setError(null);
          return null;
        }

        const msg = humanizeError(raw);
        setError(msg);
        toast(msg, "error");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [walletPubkey, userAccount, nftMint, signTransaction, connection, toast],
  );

  return { transfer, loading, error };
}
