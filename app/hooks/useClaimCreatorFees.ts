"use client";

/**
 * Claim creator fees on one market or on many, from the /my-markets dashboard.
 *
 * `useCreatorClaim` can only claim the market its SlabProvider is bound to,
 * which is why the claim UI was one panel per row's expand drawer. This hook
 * takes slab addresses, so the dashboard can offer a claim button per market and
 * a single "claim all".
 *
 * ONE TRANSACTION PER MARKET, ONE APPROVAL (UX WP-9, audit §3.11 MM-1). Batching every claim
 * into one transaction would fail as a unit: tag 90 is CAS-bound to asset 0's `authority_epoch`,
 * so if any one market's epoch moves between read and send, the creator claims NOTHING. So each
 * market stays its own transaction (a partial success banks the markets that worked), but all of
 * them are signed with ONE signAll (lib/one-approval.ts): each is simulated first, a refused one
 * is reported and never signed.
 *
 * Bytes are fetched per market immediately before building, never reused from a
 * render-time snapshot — the amount on the wire must match the counter the
 * instruction debits.
 */

import { useCallback, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletCompat, useConnectionCompat } from "@/hooks/useWalletCompat";
import type { TransactionInstruction } from "@solana/web3.js";
import { broadcastSignedTx, buildBatchTx, getFreshBlockhash, getPriorityFee, isConfirmationTimeoutError, signAllCompat, simulateForGate } from "@/lib/tx";
import { sizeComputeUnitLimit } from "@/lib/compute-budget";
import { runOneApproval } from "@/lib/one-approval";
import { getConfig } from "@/lib/config";
import { assertKnownProgram } from "@/lib/programAllowlist";
import { buildCreatorFeeClaimIx, CreatorFeeClaimError } from "@/lib/creator-fee-claim-ix";
import { mapCreatorClaimError } from "@/lib/creatorClaimError";

export interface ClaimOutcome {
  slab: string;
  /** Transaction signature on success (CONFIRMED). */
  signature?: string;
  /** User-facing reason on failure — already passed through mapCreatorClaimError. */
  error?: string;
  /** Atoms actually submitted, for the success message (and for a pending claim). */
  amount?: bigint;
  /**
   * #2742: the claim WAS broadcast but did not confirm before the poll deadline, so it may still
   * land. Neither a success (never counted in the "Claimed {total}" line) nor a failure (the
   * signature is kept so the creator can check it on the explorer). A separate field, not
   * `signature`, so every existing "did it land?" check (`o.signature`) stays confirmed-only.
   */
  pendingSignature?: string;
}

/** #2743: the pre-sign simulation could not run, so the claim was NOT sent. */
export const CLAIM_UNCHECKED_MESSAGE = "Couldn't reach Solana to check this claim, so nothing was sent. Try again in a moment.";

/**
 * The signature of a claim that was broadcast but whose confirmation timed out, else null.
 * broadcastSignedTx attaches `.signature` to ANY post-send error, including a definite on-chain
 * failure ("Transaction failed: …"), so the signature alone is not enough: only the poll
 * deadline (`isConfirmationTimeoutError`) is indeterminate. Total: a hostile error object
 * (throwing getter) reads as "not pending".
 */
function pendingClaimSignature(err: unknown): string | null {
  try {
    if (!isConfirmationTimeoutError(err)) return null;
    const sig = (err as { signature?: unknown } | null)?.signature;
    return typeof sig === "string" && sig.length > 0 ? sig : null;
  } catch {
    return null;
  }
}

export interface ClaimProgress {
  /** Slab currently being submitted, or null when idle. */
  current: string | null;
  done: number;
  total: number;
}

/** CU cap for one tag-90 claim tx (sized from its simulation below the cap). */
export const CLAIM_CU_CAP = 200_000;

export interface ClaimOptions {
  /** Called once per market whose claim CONFIRMED, as it confirms (re-read balances here). */
  onLanded?: (slab: string) => void;
}

/**
 * A guard failure already reads well; anything else goes through the shared mapper.
 *
 * TOTAL BY CONSTRUCTION — this is the error path for the whole claim, so it must
 * not be able to throw on its way to reporting a throw. `JSON.stringify` throws
 * outright on a BigInt field or a circular reference (both occur in RPC error
 * payloads), and RETURNS `undefined` for `undefined`, a function or a symbol —
 * which would then reach `humanizeError(rawMsg: string)` as a non-string and
 * throw there instead. Either one would reject out of `claim()` from inside its
 * own catch block, which is the stuck-button bug coming back by a narrower door.
 */
function claimErrorText(err: unknown): string {
  if (err instanceof CreatorFeeClaimError) return err.message;
  let raw: string;
  if (err instanceof Error) raw = err.message;
  else if (typeof err === "string") raw = err;
  else {
    try {
      raw = JSON.stringify(err) ?? String(err);
    } catch {
      raw = String(err);
    }
  }
  return mapCreatorClaimError(raw);
}

/**
 * The result line (audit §3.11): "Claimed {total} from {n} markets." and, on a partial result,
 * "Claimed {x} from {n-k} markets. {k} couldn't be claimed right now; we'll show them here."
 */
export function claimAllResultCopy(outcomes: readonly ClaimOutcome[], fmt: (atoms: bigint) => string): string | null {
  const ok = outcomes.filter((o) => o.signature);
  // #2742: submitted-but-unconfirmed claims are neither in the total (confirmed money only) nor
  // counted as "couldn't be claimed" (they may well have landed).
  const pending = outcomes.filter((o) => !o.signature && o.pendingSignature).length;
  const bad = outcomes.length - ok.length - pending;
  if (outcomes.length === 0) return null;
  const total = ok.reduce((a, o) => a + (o.amount ?? 0n), 0n);
  const n = ok.length;
  const head = `Claimed ${fmt(total)} from ${n} market${n === 1 ? "" : "s"}.`;
  if (pending === 0) {
    if (bad === 0) return head;
    if (n === 0) return `${bad} market${bad === 1 ? "" : "s"} couldn't be claimed right now; we'll show ${bad === 1 ? "it" : "them"} here.`;
    return `${head} ${bad} couldn't be claimed right now; we'll show them here.`;
  }
  const parts: string[] = [];
  if (n > 0) parts.push(head);
  parts.push(`${pending} claim${pending === 1 ? "" : "s"} sent but not confirmed yet; check ${pending === 1 ? "it" : "them"} on the explorer.`);
  if (bad > 0) parts.push(`${bad} couldn't be claimed right now.`);
  return parts.join(" ");
}

export function useClaimCreatorFees() {
  const wallet = useWalletCompat();
  const { connection } = useConnectionCompat();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ClaimProgress>({ current: null, done: 0, total: 0 });
  const [outcomes, setOutcomes] = useState<ClaimOutcome[]>([]);

  const claim = useCallback(
    async (slabs: readonly string[], opts: ClaimOptions = {}): Promise<ClaimOutcome[]> => {
      if (slabs.length === 0) return [];
      if (!wallet.publicKey || !wallet.signTransaction) {
        const failed = slabs.map((slab) => ({ slab, error: "Wallet not connected" }));
        setOutcomes(failed);
        return failed;
      }

      setBusy(true);
      setOutcomes([]);
      setProgress({ current: null, done: 0, total: slabs.length });

      // Read at send time, per the module note above; a market that cannot build is reported.
      const results = new Map<string, ClaimOutcome>();
      const units: { key: string; instructions: TransactionInstruction[]; amount: bigint }[] = [];
      // runOneApproval builds and broadcasts the signed units in the SAME order (one-approval.ts),
      // and signAll may hand back new transaction objects, so units are matched by position.
      const builtKeys: string[] = [];
      let broadcastIndex = 0;
      try {
        // Inside the try on purpose: getConfig/new PublicKey/assertKnownProgram all
        // throw (a mis-set program id, an unlisted program), and a throw here used to
        // reject out of the hook with no outcome for the caller to render.
        const programId = new PublicKey(getConfig().programId as string);
        assertKnownProgram(programId.toBase58());

        for (const slab of slabs) {
          try {
            const market = new PublicKey(slab);
            const info = await connection.getAccountInfo(market);
            if (!info?.data) throw new CreatorFeeClaimError("Market account not found.");
            const built = await buildCreatorFeeClaimIx({ programId, market, raw: new Uint8Array(info.data), claimant: wallet.publicKey });
            units.push({ key: slab, instructions: [built.instruction], amount: built.amount });
          } catch (err) {
            results.set(slab, { slab, error: claimErrorText(err) });
          }
        }
        if (units.length > 0) {
          const payer = wallet.publicKey;
          const [blockhash, fee] = await Promise.all([getFreshBlockhash(connection, true), getPriorityFee(connection)]);
          const outcomes = await runOneApproval(units, {
            simulate: async (ixs) => {
              const g = await simulateForGate(connection, payer, ixs);
              // #2743: `rpcFailed` (no verdict) must reach the gate — with `err: null` alone it
              // read as "would land" and the claim was signed with no pre-check.
              return { err: g.err, consumed: g.consumed, unchecked: g.rpcFailed };
            },
            build: (ixs, consumed, i) => {
              const tx = buildBatchTx({ instructions: ixs, computeUnits: sizeComputeUnitLimit(consumed, { cap: CLAIM_CU_CAP }), priorityFeeMicroLamports: fee + i, blockhash, feePayer: payer });
              builtKeys[i] = units.find((u) => u.instructions === ixs)?.key ?? "";
              return tx;
            },
            signAll: (txs) => signAllCompat(wallet, txs),
            // Per transaction, as each confirms: progress moves and the caller re-reads that
            // market's balance, so a partial success shows up while the rest are still going.
            broadcast: async (tx) => {
              const key = builtKeys[broadcastIndex++] || null;
              setProgress((p) => ({ ...p, current: key }));
              try {
                const sig = await broadcastSignedTx(connection, tx);
                if (key) {
                  try { opts.onLanded?.(key); } catch { /* a caller's refresh never fails a landed claim */ }
                }
                return sig;
              } finally {
                setProgress((p) => ({ ...p, current: null, done: p.done + 1 }));
              }
            },
          });
          for (const [i, o] of outcomes.entries()) {
            const u = units[i]!;
            // A SIGNATURE IS BANKED UNCONDITIONALLY, and only the error branch is
            // allowed to run mapping code. Once a transaction is on the wire this
            // loop is the only thing that can still throw, and a throw here would
            // leave later units unwritten for the catch below to relabel — telling
            // a creator a claim failed when it actually landed, with the signature
            // discarded. Structural, so it does not depend on the error mapper
            // staying total.
            if (o.ok) {
              results.set(u.key, { slab: u.key, signature: o.signature, amount: u.amount });
            } else {
              // #2742: a confirmation timeout is indeterminate — keep the signature, never "failed".
              const pendingSig = o.stage === "failed" ? pendingClaimSignature(o.error) : null;
              if (pendingSig) {
                results.set(u.key, { slab: u.key, pendingSignature: pendingSig, amount: u.amount });
                continue;
              }
              let text: string;
              try {
                text = o.stage === "unchecked" ? CLAIM_UNCHECKED_MESSAGE : claimErrorText(o.error);
              } catch {
                text = "Claim failed.";
              }
              results.set(u.key, { slab: u.key, error: text });
            }
          }
        }
      } catch (err) {
        // Everything from the program-id checks to the wallet approval lands here:
        // a declined signature (one-approval.ts:42 awaits signAll outside its try)
        // or a getLatestBlockhash failure. These used to reject out of the hook,
        // skipping the release below and stranding the button on "claiming…".
        // Report per market instead — `claim()` is typed to RESOLVE with outcomes
        // and both callers read the resolved array.
        // Guarded for the same reason as the loop above: this is the last code
        // between a throw and the caller, so it must not be able to throw itself.
        // That keeps "claim() resolves" a property of this function rather than
        // an inherited promise about the shared error mapper.
        let text: string;
        try {
          text = claimErrorText(err);
        } catch {
          text = "Claim failed.";
        }
        for (const slab of slabs) {
          // Never overwrite a market that already has a verdict — a build failure
          // with its own specific reason, or a claim that already succeeded.
          if (!results.has(slab)) results.set(slab, { slab, error: text });
        }
      } finally {
        // The ONE release. In a `finally` rather than on the last line so that no
        // await added to the body above can ever strand the button again.
        setBusy(false);
      }
      const ordered = slabs.map((slab) => results.get(slab)!);
      setOutcomes(ordered);
      setProgress({ current: null, done: slabs.length, total: slabs.length });
      return ordered;
    },
    [wallet, connection],
  );

  const reset = useCallback(() => {
    // `busy` too: a reset that leaves the component reading "claiming…" on a
    // disabled button is not a reset. Nothing calls this today, so it is the
    // escape hatch being made correct rather than a live recovery path.
    setBusy(false);
    setOutcomes([]);
    setProgress({ current: null, done: 0, total: 0 });
  }, []);

  return { claim, busy, progress, outcomes, reset };
}
