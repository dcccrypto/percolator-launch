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
import { createHash } from "node:crypto";
import { attributeFailure, instructionFailureOf } from "@/lib/bot-api/onchain";
import { anyReservations, releaseByMessageHash, reservationFor } from "@/lib/bot-api/reduce-reservations";

export type TxState = "pending" | "processed" | "confirmed" | "finalized" | "failed" | "expired" | "unknown";

export function validSignature(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s)) return false;
  try {
    return bs58.decode(s).length === 64;
  } catch {
    return false;
  }
}

/**
 * Ends the reduce-only reservation this transaction held, best effort (a store or RPC failure leaves it to its TTL):
 *  - landed (any status with a slot): the landed message's sha256 is the reservation id; read only when a reservation exists.
 *  - not landed, with ?messageHash=: released only when the chain is past the lastValidBlockHeight that build carried, so
 *    the bytes can never land (anyone asking cannot release a live reservation early).
 */
async function releaseReservation(connection: Connection, signature: string, landed: boolean, messageHash: string | null, meta: { rpcCalls: number }, landedTx?: Awaited<ReturnType<Connection["getTransaction"]>> | null): Promise<boolean> {
  try {
    if (landed) {
      if (!(await anyReservations())) return false;
      let tx = landedTx;
      if (tx === undefined) {
        meta.rpcCalls++;
        tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      }
      if (!tx) return false;
      const hash = createHash("sha256").update(tx.transaction.message.serialize()).digest("hex");
      return await releaseByMessageHash(hash);
    }
    if (!messageHash) return false;
    const r = await reservationFor(messageHash);
    if (!r || r.entry.lvbh === null) return false;
    meta.rpcCalls++;
    const height = await connection.getBlockHeight("confirmed");
    return height > r.entry.lvbh ? await releaseByMessageHash(messageHash) : false;
  } catch {
    return false;
  }
}

export async function txStatus(connection: Connection, signature: string, lastValidBlockHeight: number | null, meta: { rpcCalls: number }, opts: { messageHash?: string | null } = {}) {
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
    const reservationReleased = await releaseReservation(connection, signature, false, opts.messageHash ?? null, meta);
    return { signature, status: state, slot: null, confirmations: null, err: null, blockHeight, lastValidBlockHeight, observedAt, reservationReleased };
  }
  if (st.err) {
    // The status carries only the error; the program that returned a Custom(n) is read from the landed transaction (its logs, else
    // the program of the failing instruction). One extra read, only for a failed transaction; if it fails the code is reported unnamed.
    let onchain: ReturnType<typeof attributeFailure> | null = null;
    let landedTx: Awaited<ReturnType<Connection["getTransaction"]>> | null | undefined;
    if (instructionFailureOf(st.err).custom !== null) {
      let logs: string[] = [];
      let programAt: ((i: number) => string | null) | undefined;
      try {
        meta.rpcCalls++;
        const tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        landedTx = tx;
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
    const reservationReleased = await releaseReservation(connection, signature, true, opts.messageHash ?? null, meta, landedTx);
    return {
      signature,
      status: "failed" as TxState,
      slot: st.slot,
      confirmations: st.confirmations ?? null,
      err: { raw: st.err, onchain: onchain ? onchain.onchain : null },
      blockHeight,
      lastValidBlockHeight,
      observedAt,
      reservationReleased,
    };
  }
  const reservationReleased = await releaseReservation(connection, signature, true, opts.messageHash ?? null, meta);
  return { signature, status: (st.confirmationStatus ?? "processed") as TxState, slot: st.slot, confirmations: st.confirmations ?? null, err: null, blockHeight, lastValidBlockHeight, observedAt, reservationReleased };
}
