/**
 * GET /v1/tx/{signature}: where a transaction the caller sent stands. Polling, no webhooks in v1.
 *   pending    not seen yet and (with lastValidBlockHeight) still able to land
 *   processed | confirmed | finalized   landed with no error, at that commitment
 *   failed     landed with an error (decoded when it is a wrapper Custom(n))
 *   expired    not seen and the chain is past lastValidBlockHeight: it can never land, rebuilding is safe
 *   unknown    not seen and no lastValidBlockHeight given, so expiry cannot be told
 */
import bs58 from "bs58";
import type { Connection } from "@solana/web3.js";
import { ApiError } from "@/lib/bot-api/errors";
import { attributeFailure, instructionFailureOf } from "@/lib/bot-api/onchain";

export type TxState = "pending" | "processed" | "confirmed" | "finalized" | "failed" | "expired" | "unknown";

export function validSignature(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 64;
  } catch {
    return false;
  }
}

export async function txStatus(connection: Connection, signature: string, lastValidBlockHeight: number | null, meta: { rpcCalls: number }) {
  if (!validSignature(signature)) throw new ApiError("bad_signature");
  let st: Awaited<ReturnType<Connection["getSignatureStatuses"]>>["value"][number];
  let blockHeight: number | null = null;
  try {
    meta.rpcCalls++;
    const r = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    st = r.value[0];
    if (!st && lastValidBlockHeight !== null) {
      meta.rpcCalls++;
      blockHeight = await connection.getBlockHeight("confirmed");
    }
  } catch {
    throw new ApiError("rpc_unavailable");
  }
  const observedAt = new Date().toISOString();
  if (!st) {
    const state: TxState = lastValidBlockHeight === null ? "unknown" : blockHeight !== null && blockHeight > lastValidBlockHeight ? "expired" : "pending";
    return { signature, status: state, slot: null, confirmations: null, err: null, blockHeight, lastValidBlockHeight, observedAt };
  }
  if (st.err) {
    // The status carries only the error; the program that returned a Custom(n) is read from the landed transaction (its logs, else
    // the program of the failing instruction). One extra read, only for a failed transaction; if it fails the code is reported unnamed.
    let onchain: ReturnType<typeof attributeFailure> | null = null;
    if (instructionFailureOf(st.err).custom !== null) {
      let logs: string[] = [];
      let programAt: ((i: number) => string | null) | undefined;
      try {
        meta.rpcCalls++;
        const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        logs = tx?.meta?.logMessages ?? [];
        const msg = tx?.transaction.message;
        if (msg) {
          const keys = msg.staticAccountKeys;
          programAt = (i) => {
            const ix = msg.compiledInstructions[i];
            return ix ? keys[ix.programIdIndex]?.toBase58() ?? null : null;
          };
        }
      } catch {
        /* unattributed */
      }
      onchain = attributeFailure(st.err, logs, programAt);
    }
    return {
      signature,
      status: "failed" as TxState,
      slot: st.slot,
      confirmations: st.confirmations ?? null,
      err: { raw: st.err, onchain: onchain ? onchain.onchain : null },
      blockHeight,
      lastValidBlockHeight,
      observedAt,
    };
  }
  return { signature, status: (st.confirmationStatus ?? "processed") as TxState, slot: st.slot, confirmations: st.confirmations ?? null, err: null, blockHeight, lastValidBlockHeight, observedAt };
}
