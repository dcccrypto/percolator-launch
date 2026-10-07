"use client";

import { useState, useCallback } from "react";
import { PublicKey } from "@solana/web3.js";
import type { TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  parseHeader,
  parseConfig,
  parseWrapperConfigV17,
  V17_HEADER_LEN,
  encodeCloseSlab,
  ACCOUNTS_CLOSE_SLAB,
  encodeResolveMarket,
  ACCOUNTS_RESOLVE_MARKET,
  buildAccountMetas,
  buildIx,
  deriveVaultAuthority,
} from "@percolatorct/sdk";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import { planCloseMarket } from "@/lib/close-market-plan";
import { readAndPlanPreResolve } from "@/lib/pre-resolve";
import { getConfig } from "@/lib/config";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { parseMarketCreationError } from "@/lib/parseMarketError";
import { closeInOneApproval, closeSlabState, PRESIGNED_CLOSE_RESENDS, type CloseSlabState } from "@/lib/limits/close-slab";
import type { Connection } from "@solana/web3.js";
import { COPY } from "@/lib/limits/copy";
import { CLEANUP_CU, planOwnCleanupForOneApproval } from "@/lib/limits/own-portfolio-cleanup";
import { broadcastSignedTx, buildBatchTx, getFreshBlockhash, getPriorityFee, signAllCompat, simulateForGate, SimulationRefusal } from "@/lib/tx";

import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { plainMessage } from "@/lib/limits/user-message";
import { isWrapperAccount } from "@/lib/v22/layout";
/** Slab state after `sig`, read at (at least) the tx's slot so a cached pre-close read can't answer. */
export async function readCloseSlabStateAfter(
  connection: { getSignatureStatuses: Connection["getSignatureStatuses"]; getAccountInfo: Connection["getAccountInfo"] },
  slab: PublicKey,
  sig: string,
): Promise<CloseSlabState> {
  try {
    const st = await connection.getSignatureStatuses([sig]);
    const slot = st.value[0]?.slot;
    const info = await connection.getAccountInfo(
      slab,
      slot == null ? "confirmed" : { commitment: "confirmed", minContextSlot: slot },
    );
    return closeSlabState(info ? new Uint8Array(info.data) : null);
  } catch {
    return "unknown";
  }
}

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

        // --- SECURITY GUARD: parse header/config and verify admin before sending any tx ---
        let slabAdmin: PublicKey;
        try {
          const data = new Uint8Array(accountInfo.data);
          if (isWrapperAccount(data)) {
            // v17: admin is in WrapperConfigV17.marketauth (at V17_HEADER_LEN offset)
            const cfg = parseWrapperConfigV17(data, V17_HEADER_LEN);
            slabAdmin = cfg.marketauth;
          } else {
            // v12: admin is in the slab header
            const header = parseHeader(accountInfo.data);
            slabAdmin = header.admin;
          }
        } catch {
          // parseHeader / parseWrapperConfigV17 throws when magic bytes are wrong (uninitialised slab).
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

        // beta.32: ACCOUNTS_CLOSE_SLAB expanded to 6 accounts:
        // dest (admin/signer), slab, vault, vaultAuthority, destAta, tokenProgram
        const data = new Uint8Array(accountInfo.data);
        let vaultPubkey: PublicKey;
        let collateralMint: PublicKey;
        if (isWrapperAccount(data)) {
          // v17: vaultPubkey is derived (not stored), collateralMint from WrapperConfigV17
          const v17cfg = parseWrapperConfigV17(data, V17_HEADER_LEN);
          collateralMint = v17cfg.collateralMint;
          // vault ATA is derived from vaultAuthority PDA
          const [va] = deriveVaultAuthority(programId, slabPk);
          const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
          vaultPubkey = getAssociatedTokenAddressSync(collateralMint, va, true);
        } else {
          const slabConfig = parseConfig(accountInfo.data);
          vaultPubkey = slabConfig.vaultPubkey;
          collateralMint = slabConfig.collateralMint;
        }
        const [vaultAuthority] = deriveVaultAuthority(programId, slabPk);
        const destAta = await getAssociatedTokenAddress(collateralMint, walletCompat.publicKey);

        // v18: a Live market (every half-created one) must be resolved before
        // CloseSlab will accept it — see lib/close-market-plan.ts. v12 slabs have
        // no such lifecycle (and no authority-epoch lane: 0n).
        let authorityEpoch = 0n;
        let resolveIx: ReturnType<typeof buildIx> | null = null;
        let preResolveCranks: TransactionInstruction[] = [];
        let cleanupGroups: TransactionInstruction[][] = [];
        if (isWrapperAccount(data)) {
          const plan = planCloseMarket(data);
          if (!plan.ok) {
            setError(
              "Cannot reclaim: this market already holds user capital or open accounts, so it " +
              "can't be closed from here. Resume creation to finish it instead."
            );
            setLoading(false);
            return null;
          }
          authorityEpoch = plan.authorityEpoch;
          // E2E B12: on an already-RESOLVED market, CloseSlab needs materialized_portfolio_count
          // == 0, and CloseResolved alone does not dematerialize. Close the wallet's OWN
          // portfolios first (owner-signed 30 / 46 -> 8), each sim-gated, then re-check.
          // UX WP-9: the cleanups are PLANNED here (each sim-gated) and signed with the CloseSlab
          // tx in the one approval below, instead of one surprise prompt each.
          if (!plan.resolve) {
            const cleanup = await planOwnCleanupForOneApproval({
              connection,
              programId,
              market: slabPk,
              owner: walletCompat.publicKey,
              collateralMint,
              vaultToken: vaultPubkey,
              vaultAuthority,
            });
            if (!cleanup.ok) {
              setError(COPY.reclaimCleanup[cleanup.reason](cleanup.remaining !== undefined ? String(cleanup.remaining) : ""));
              setLoading(false);
              return null;
            }
            cleanupGroups = cleanup.groups;
          }
          if (plan.resolve) {
            // P0b pre-resolve gate (fee-flow audit F4): crank the Live-only LP (78) and
            // staker (87 → stake 12) legs in THIS tx before ResolveMarket, and refuse
            // when a leg is owed that can't be cranked or the creator's own fees are
            // unclaimed — CloseSlab would burn them. lib/pre-resolve.ts.
            const gate = await readAndPlanPreResolve(connection, {
              programId,
              stakeProgramId: new PublicKey((getConfig() as { vaultProgramId?: string }).vaultProgramId ?? DEVNET_PROGRAM_IDS.stake),
              cranker: walletCompat.publicKey,
              market: slabPk,
              marketData: data,
            });
            if (gate.blockers.length > 0) {
              setError(`Cannot reclaim yet: ${gate.blockers.join(" ")}`);
              setLoading(false);
              return null;
            }
            for (const w of gate.warnings) console.warn("[useCloseMarket] pre-resolve:", w);
            preResolveCranks = gate.cranks;
            resolveIx = buildIx({
              programId,
              keys: buildAccountMetas(ACCOUNTS_RESOLVE_MARKET, {
                admin: walletCompat.publicKey,
                market: slabPk,
              }),
              data: encodeResolveMarket({
                assetGenerationFrontier: plan.resolve.assetGenerationFrontier,
                authorityEpoch,
              }),
            });
          }
        }

        // Build CloseSlab instruction via SDK encode helpers
        const ix = buildIx({
          programId,
          keys: buildAccountMetas(ACCOUNTS_CLOSE_SLAB, {
            dest: walletCompat.publicKey,
            slab: slabPk,
            vault: vaultPubkey,
            vaultAuthority,
            destAta,
            tokenProgram: TOKEN_PROGRAM_ID,
          }),
          // v18: CloseSlab is CAS-bound to asset 0's authority_epoch lane — pass
          // the LIVE current value (not +1). v12 slabs have no such lane (0n).
          data: encodeCloseSlab(authorityEpoch),
        });

        // UX WP-9 (audit §3.11, MM-2): ONE approval. The own-portfolio cleanups, the main tx
        // (pre-resolve cranks + ResolveMarket + CloseSlab, or CloseSlab alone) and
        // PRESIGNED_CLOSE_RESENDS CloseSlab copies are signed together; a copy is broadcast only
        // while the slab still reads as a live market (P1 F4: CloseSlab can return Ok WITHOUT
        // closing — a fee-leg re-book). The v17 wrapper needs the full heap frame first
        // (buildBatchTx adds it); 1.4M covers the pre-resolve cranks (≤ 250k).
        const payer = walletCompat.publicKey;
        const [blockhash, fee] = await Promise.all([getFreshBlockhash(connection, true), getPriorityFee(connection)]);
        const mk = (instructions: TransactionInstruction[], units: number, i: number) =>
          buildBatchTx({ instructions, computeUnits: units, priorityFeeMicroLamports: fee + i, blockhash, feePayer: payer });
        const mainIxs = [...preResolveCranks, ...(resolveIx ? [resolveIx] : []), ix];
        // Pre-sign verdict on what can be simulated now (the cleanups were simulated when planned;
        // with cleanups pending, CloseSlab can only succeed after them, so it is not simulated).
        if (cleanupGroups.length === 0) {
          const g = await simulateForGate(connection, payer, mainIxs);
          if (g.err) throw new SimulationRefusal(g.err, g.logs, g.simulated);
        }
        const closed = await closeInOneApproval({
          cleanup: cleanupGroups.map((g, i) => mk(g, CLEANUP_CU, i)),
          main: mk(mainIxs, 1_400_000, cleanupGroups.length),
          resends: Array.from({ length: PRESIGNED_CLOSE_RESENDS }, (_, i) => mk([ix], 1_400_000, cleanupGroups.length + 1 + i)),
          signAll: (txs) => signAllCompat(walletCompat, txs),
          broadcast: (t) => broadcastSignedTx(connection, t),
          readState: (s) => readCloseSlabStateAfter(connection, slabPk, s),
          rebookedMessage: COPY.closeRebooked,
        });
        let sig = closed.signature;


        // Clean up localStorage
        localStorage.removeItem("percolator-pending-slab-keypair");

        setLoading(false);
        return { signature: sig, reclaimedLamports: reclaimableLamports };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        // Parse common CloseSlab failures
        if (msg === COPY.closeRebooked) {
          setError(msg);
        } else if (msg.includes("0xd") || msg.includes("EngineInsufficientBalance")) {
          setError(
            "Cannot close: the slab vault or insurance fund still has tokens. " +
            "Complete market creation to use those funds, or contact support to drain them."
          );
        } else if (msg.includes("0x10") || msg.includes("AccountNotFound")) {
          setError("Cannot close: there are still open user accounts on this market.");
        } else if (msg.includes("User rejected") || msg.includes("WalletSign")) {
          setError("Transaction cancelled.");
        } else if (new RegExp(`custom program error:\\s*0x${WRAPPER_ERR.EngineLockActive.toString(16)}\\b`, "i").test(msg) || msg.includes("EngineLockActive")) {
          // 0x15 = Custom(21) = EngineLockActive: CloseSlab's preconditions aren't met.
          // It is not a transient lock — waiting never helps. The Live-market case is
          // handled above (ResolveMarket is prepended), and capital/portfolios are
          // caught before sending, so what remains is the LP-vault backing floor a
          // market gets once its Earn vault exists — CloseSlab refuses that by design.
          setError(
            "Cannot reclaim: this market got far enough to create its Earn vault, and the " +
            "program permanently blocks closing a market once that exists. Resume creation " +
            "to finish it instead."
          );
        } else {
          // Any other custom-program-error code: reuse the same decoder the create-market
          // wizard uses (SDK PERCOLATOR_ERRORS hint table) instead of dumping the raw
          // simulation log, so an unrecognised code still gets a real explanation where
          // possible rather than an opaque "custom program error: 0xNN".
          // UX WP-1: the one resolver first; the create-market decoder only for codes it
          // does not own, and never raw simulation text.
          const decoded = parseMarketCreationError(err);
          setError(
            plainMessage(err, { surface: "close-market" }, () =>
              decoded.startsWith("Transaction failed:") ? "Something went wrong and nothing was sent." : decoded,
            )
          );
        }

        setLoading(false);
        return null;
      }
    },
    [walletCompat, connection],
  );

  return { closeSlab, loading, error };
}
