"use client";

import { useState, useCallback } from "react";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  parseHeader,
  encodeCloseSlab,
  ACCOUNTS_CLOSE_SLAB,
  buildAccountMetas,
  buildIx,
} from "@percolatorct/sdk";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";

/**
 * CloseSlab (IX_TAG.CloseSlab = 13) instruction in percolator-prog.
 * Accounts: [admin(signer, writable), slab(writable)]
 * Data: encodeCloseSlab() — 1 byte
 *
 * Requirements:
 * - Admin must sign (on-chain guard — mismatch = guaranteed rejection)
 * - Vault balance must be zero
 * - Insurance balance must be zero
 * - No open user accounts
 * - dust_base must be zero
 *
 * SECURITY: This hook reads the on-chain slab header and validates that the
 * connected wallet is the market admin BEFORE building or sending any tx.
 * Non-admin callers get a clear error with zero fees wasted.
 */

interface CloseResult {
  signature: string;
  reclaimedLamports: number;
}

export function useCloseMarket() {
  const walletCompat = useWalletCompat();
  const { connection } = useConnectionCompat();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Close a slab and reclaim rent.
   * Only works if the connected wallet is the market admin AND
   * vault/insurance are empty with no open user accounts.
   *
   * @param slabAddress - The slab account public key
   * @param programIdOverride - Optional program ID (auto-detected from slab owner if omitted)
   */
  const closeSlab = useCallback(
    async (slabAddress: string, programIdOverride?: string): Promise<CloseResult | null> => {
      if (!walletCompat.publicKey || !walletCompat.signTransaction) {
        setError("Wallet not connected");
        return null;
      }

      setLoading(true);
      setError(null);

      try {
        const slabPk = new PublicKey(slabAddress);

        // Fetch the slab account
        const accountInfo = await connection.getAccountInfo(slabPk);
        if (!accountInfo) {
          // Account doesn't exist — nothing to reclaim.
          localStorage.removeItem("percolator-pending-slab-keypair");
          setError("Slab account no longer exists (already reclaimed or rolled back).");
          setLoading(false);
          return null;
        }

        // --- SECURITY GUARD: parse header and verify admin before sending any tx ---
        let slabAdmin: PublicKey;
        try {
          const header = parseHeader(accountInfo.data);
          slabAdmin = header.admin;
        } catch {
          // parseHeader throws when magic bytes are wrong (uninitialised slab).
          // CloseSlab (tag 13) requires an initialised slab — use ReclaimSlabRent
          // (tag 52 / useReclaimSlabRent) for uninitialised slabs instead.
          setError(
            "This slab is not yet initialised. Use the ReclaimSlabRent flow to recover SOL from an uninitialised slab."
          );
          setLoading(false);
          return null;
        }

        if (!slabAdmin.equals(walletCompat.publicKey)) {
          setError(
            "Only the market admin can close this slab. " +
            `Admin: ${slabAdmin.toBase58().slice(0, 8)}… — ` +
            "connect the admin wallet to proceed."
          );
          setLoading(false);
          return null;
        }
        // --- END SECURITY GUARD ---

        const reclaimableLamports = accountInfo.lamports;
        const programId = programIdOverride
          ? new PublicKey(programIdOverride)
          : accountInfo.owner;

        // Build CloseSlab instruction via SDK encode helpers
        const ix = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_CLOSE_SLAB, {
            admin: walletCompat.publicKey,
            slab: slabPk,
          }),
          data: encodeCloseSlab(),
        });

        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({
          recentBlockhash: blockhash,
          feePayer: walletCompat.publicKey,
        });
        tx.add(ix);

        const signed = await walletCompat.signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        await connection.confirmTransaction(sig, "confirmed");

        // Clean up localStorage
        localStorage.removeItem("percolator-pending-slab-keypair");

        setLoading(false);
        return { signature: sig, reclaimedLamports: reclaimableLamports };
      } catch (err: any) {
        const msg = err?.message ?? String(err);

        // Parse common CloseSlab failures
        if (msg.includes("0xd") || msg.includes("EngineInsufficientBalance")) {
          setError(
            "Cannot close: the slab vault or insurance fund still has tokens. " +
            "Complete market creation to use those funds, or contact support to drain them."
          );
        } else if (msg.includes("0x10") || msg.includes("AccountNotFound")) {
          setError("Cannot close: there are still open user accounts on this market.");
        } else if (msg.includes("User rejected") || msg.includes("WalletSign")) {
          setError("Transaction cancelled.");
        } else {
          setError(`Failed to close slab: ${msg.slice(0, 200)}`);
        }

        setLoading(false);
        return null;
      }
    },
    [walletCompat, connection],
  );

  return { closeSlab, loading, error };
}
