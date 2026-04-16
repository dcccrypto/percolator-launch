"use client";

import { useCallback, useState } from "react";
import { Keypair, PublicKey, Transaction, SendTransactionError } from "@solana/web3.js";
import {
  parseHeader,
  encodeReclaimSlabRent,
  ACCOUNTS_RECLAIM_SLAB_RENT,
  buildAccountMetas,
  buildIx,
} from "@percolatorct/sdk";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { getConfig } from "@/lib/config";


export type ReclaimStatus = "idle" | "sending" | "success" | "error";

export interface UseReclaimSlabRentResult {
  status: ReclaimStatus;
  error: string | null;
  txSig: string | null;
  /** Call to send the ReclaimSlabRent instruction on-chain. */
  reclaim: (slabKeypair: Keypair) => Promise<void>;
}

/**
 * Translate raw Solana / Percolator program error codes into user-friendly messages.
 *
 * Program custom errors (InstructionError.Custom codes) come from percolator-prog's
 * PercolatorError enum.  The numbers are derived from the on-chain error list.
 */
function friendlyReclaimError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // --- User-rejected / wallet errors ---
  if (lower.includes("user rejected") || lower.includes("rejected the request")) {
    return "Transaction cancelled — you rejected the signing request.";
  }
  if (lower.includes("not connected") || lower.includes("wallet not connected")) {
    return "Wallet not connected. Please connect your wallet and try again.";
  }

  // --- Solana runtime errors (0x prefix = program custom code in hex) ---
  // 0x4 = AccountNotInitialized / uninit slab already cleaned up
  if (lower.includes("0x4") || lower.includes("custom: 4")) {
    return "Slab account is no longer on-chain. It may have already been reclaimed.";
  }
  // 0xf = Custom:15 — reserved for skip-thrash in keeper, unlikely here but map it
  if (lower.includes("0xf") || lower.includes("custom: 15")) {
    return "Program rejected the request (error 0xf). The slab may still be initialised.";
  }
  // 0x0 = InstructionError (slab is already initialized — magic byte set)
  if (lower.includes("custom: 0") || lower.includes("0x0 ")) {
    return "This slab is already initialised. Use the market close flow to reclaim rent.";
  }
  // Slab already reclaimed / account lamports = 0
  if (lower.includes("attempt to debit") || lower.includes("insufficient lamport")) {
    return "Slab account has no SOL to reclaim — it may already be closed.";
  }

  // --- Transaction simulation / preflight ---
  if (lower.includes("simulation failed") || lower.includes("preflight")) {
    // Try to extract the custom error code from the simulation logs
    const customMatch = msg.match(/custom program error:\s*0x([0-9a-f]+)/i);
    if (customMatch) {
      const code = parseInt(customMatch[1], 16);
      if (code === 0) return "This slab is already initialised. Use the market close flow to reclaim rent.";
      if (code === 4) return "Slab account is not owned by a recognised Percolator program.";
      return `Program rejected with error code 0x${customMatch[1]}. Try again or contact support.`;
    }
    return "Transaction simulation failed. The slab state may have changed — please refresh and try again.";
  }

  // --- Network / timeout errors ---
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Transaction timed out. Check your wallet for a pending signature, or try again.";
  }
  if (lower.includes("network") || lower.includes("econnreset") || lower.includes("fetch")) {
    return "Network error. Check your connection and try again.";
  }
  if (lower.includes("blockhash not found") || lower.includes("blockhash expired")) {
    return "Transaction expired. Please try again.";
  }

  // --- Generic fallback: keep the original message but trim internal noise ---
  const short = msg.replace(/Error:\s*/gi, "").slice(0, 120);
  return `Reclaim failed: ${short}${msg.length > 120 ? "…" : ""}`;
}

/**
 * PERC-511: Hook that sends the ReclaimSlabRent (tag 52) instruction.
 *
 * This reclaims SOL from an uninitialised slab account (magic = 0) when
 * market creation failed mid-flow. The slab keypair must be available so
 * the slab account can sign the transaction (proves ownership).
 *
 * Accounts:
 *   [0] dest    — wallet pubkey (signer, writable) — receives reclaimed lamports
 *   [1] slab    — slab pubkey  (signer, writable) — must have magic != MAGIC on-chain
 */
export function useReclaimSlabRent(): UseReclaimSlabRentResult {
  const walletCompat = useWalletCompat();
  const { connection } = useConnectionCompat();

  const [status, setStatus] = useState<ReclaimStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txSig, setTxSig] = useState<string | null>(null);

  const reclaim = useCallback(
    async (slabKeypair: Keypair) => {
      if (!walletCompat.publicKey) {
        setError("Wallet not connected");
        return;
      }

      if (!walletCompat.signTransaction) {
        setError("Wallet does not support signing");
        return;
      }

      const dest = walletCompat.publicKey;
      const slab = slabKeypair.publicKey;

      // Build the set of all known Percolator program IDs (env default + all tier-specific programs).
      // PERC-1095: Small/Medium/Large slabs are owned by their tier program, not NEXT_PUBLIC_PROGRAM_ID.
      const cfg = getConfig();
      const knownProgramIds = new Set<string>([
        process.env.NEXT_PUBLIC_PROGRAM_ID ?? "",
        // PERC-1095 follow-up: also include cfg.programId (the runtime-resolved program ID for
        // mainnet-large slabs and any tier without an entry in programsBySlabTier).
        cfg.programId,
        ...(cfg.programsBySlabTier ? Object.values(cfg.programsBySlabTier) : []),
      ].filter(Boolean));

      setStatus("sending");
      setError(null);
      setTxSig(null);

      try {
        // Verify the slab is still uninitialised on-chain before sending
        const accountInfo = await connection.getAccountInfo(slab);
        if (!accountInfo) {
          setError(
            "Slab account not found on-chain. The transaction may have already rolled back — no SOL was lost."
          );
          setStatus("error");
          return;
        }

        // PERC-1095: Use the slab's actual on-chain owner as the program ID.
        // Small/Medium/Large slabs are owned by their respective tier programs,
        // not necessarily NEXT_PUBLIC_PROGRAM_ID (the Large program).
        const programId = accountInfo.owner;
        if (!knownProgramIds.has(programId.toBase58())) {
          setError(
            "Slab account is not owned by a Percolator program. Cannot reclaim."
          );
          setStatus("error");
          return;
        }

        // Guard: if parseHeader succeeds (magic bytes = PERCOLAT), the market is
        // initialised — use CloseSlab (useCloseMarket) instead of ReclaimSlabRent.
        try {
          parseHeader(accountInfo.data);
          // parseHeader only succeeds when magic is valid — slab is initialised.
          setError(
            "This slab is already initialised (market exists). Use the normal market close flow instead of rent reclaim."
          );
          setStatus("error");
          return;
        } catch {
          // Expected: uninitialised slab has wrong/absent magic — proceed with reclaim.
        }

        // Build ReclaimSlabRent instruction via SDK encode helpers (tag 52)
        const ix = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_RECLAIM_SLAB_RENT, {
            dest,
            slab,
          }),
          data: encodeReclaimSlabRent(),
        });

        // GH#1488: Fetch a fresh blockhash IMMEDIATELY before building the tx so
        // it doesn't expire while Privy's signing modal is open.  On blockhash-not-found
        // we retry once more with another fresh blockhash (covers slow approval paths).
        const MAX_BLOCKHASH_RETRIES = 2;
        let sig: string | null = null;

        for (let attempt = 0; attempt < MAX_BLOCKHASH_RETRIES; attempt++) {
          // Fetch fresh blockhash each attempt
          const { blockhash, lastValidBlockHeight } =
            await connection.getLatestBlockhash("confirmed");

          const tx = new Transaction({
            feePayer: dest,
            blockhash,
            lastValidBlockHeight,
          });
          tx.add(ix);

          // Step 1: slab keypair signs (proves ownership of the uninitialised slab)
          tx.partialSign(slabKeypair);

          // Step 2: wallet (Privy) signs — uses signTransaction consistent with rest of codebase.
          // GH#1488: signing happens AFTER blockhash fetch so latency from the Privy modal
          // does not stale the blockhash before broadcast.
          const signedTx = await walletCompat.signTransaction(tx);

          // Step 3: broadcast
          let rawSig: string;
          try {
            rawSig = await connection.sendRawTransaction(signedTx.serialize(), {
              skipPreflight: false,
            });
          } catch (sendErr: unknown) {
            const sendMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
            const isBlockhashErr =
              sendMsg.toLowerCase().includes("blockhash not found") ||
              sendMsg.toLowerCase().includes("blockhash expired");

            if (isBlockhashErr && attempt < MAX_BLOCKHASH_RETRIES - 1) {
              // Retry immediately with a fresh blockhash (next loop iteration).
              // We don't re-open the Privy modal — the same signedTx cannot be re-used
              // because the blockhash is embedded; we need to re-sign with new hash.
              console.warn(`[useReclaimSlabRent] blockhash expired on attempt ${attempt + 1}, retrying…`);
              continue;
            }
            throw sendErr;
          }

          // Step 4: confirm on-chain — only show success AFTER this resolves.
          // GH#1488: previously success was inferred from Privy "Transaction signed!" which
          // fires before broadcast; now we wait for actual on-chain confirmation.
          const confirmation = await connection.confirmTransaction(
            { signature: rawSig, blockhash, lastValidBlockHeight },
            "confirmed"
          );

          if (confirmation.value.err) {
            throw new Error(
              `Transaction landed on-chain but was rejected by the program: ${JSON.stringify(confirmation.value.err)}`
            );
          }

          sig = rawSig;
          break;
        }

        if (!sig) {
          throw new Error("Transaction failed after retries. Please try again.");
        }

        setTxSig(sig);
        setStatus("success");
      } catch (err: unknown) {
        console.error("[useReclaimSlabRent] error:", err);
        // SendTransactionError carries logs — include them for debugging
        if (err instanceof SendTransactionError) {
          console.error("[useReclaimSlabRent] logs:", err.logs);
        }
        setError(friendlyReclaimError(err));
        setStatus("error");
      }
    },
    [walletCompat, connection]
  );

  return { status, error, txSig, reclaim };
}
