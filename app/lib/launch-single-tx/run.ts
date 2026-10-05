/**
 * The single-transaction market launch (Solana v1, SIMD-0385, 4,096 B): the six batched launch
 * transactions (M1, keeper co-sign, M3b, M4a, M4p, M4b) as ONE atomic transaction, one wallet prompt.
 *
 * Gate (all must hold, checked in this order, no RPC until the cheap ones pass):
 *   NEXT_PUBLIC_DEVNET_V21 on  ->  NEXT_PUBLIC_LAUNCH_SINGLE_TX != off (auto|on, default auto)
 *   ->  P3 launch  ->  the wallet advertises v1 (lib/tx-v1 resolveRawTxSigner().supportsV1)
 *   ->  the cluster reports the v1 feature active (detectTxV1Support).
 * `on` behaves as `auto` (the launch always benefits); it never bypasses the wallet or cluster check.
 *
 * Sequence (`attemptSingleTxLaunch`): structural check (shape.ts) -> compile -> simulateV1 of the
 * EXACT message (no wallet prompt on a program error) -> keeper co-sign of the message (server
 * validates, lib/launch-single-tx/cosign-validate.ts) -> local keypair signatures -> ONE wallet
 * prompt -> verify every signature -> send -> confirm.
 *
 * Outcomes, and why each is safe:
 *  - landed:   the whole market exists (atomic); the caller runs the same post-launch registration.
 *  - fallback: NOTHING was broadcast, or the send was definitively refused/expired with no slab on
 *              chain; the caller runs the existing batched path with the SAME slab keypair, so the
 *              two can never both create a market (createAccount of one address succeeds once).
 *  - refused:  simulation or on-chain program error / user declined; nothing exists; no fallback
 *              (a program error must never be "retried" in another format; a "no" is final).
 *  - unknown:  the tx may have landed and the outcome could not be resolved; never re-launch.
 */
import { type Keypair, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import {
  compileV1Message,
  isTxV1FormatRejection,
  parseTxV1Mode,
  priorityFeeLamportsFromMicroPerCu,
  signV1Message,
  v1TransactionSignature,
  TX_MAX_COMPUTE_UNITS,
  type CompiledV1Message,
  type TxV1Mode,
  type V1SimulationResult,
} from "@/lib/v21/sdk";
import { WalletAlteredMessageError, assembleSignedV1, isUserRejection, isV1WalletSigningFailure } from "@/lib/tx-v1";
import { V1TransportError } from "@/lib/tx-v1/rpc";
import { launchBundleViolations, neutralFromInstructions, type LaunchPrograms } from "./shape";

/** Wrapper BumpAllocator needs a 128 KiB heap on every tx (#176); in v1 it is the heap config bit. */
export const SINGLE_TX_HEAP_BYTES = 131_072;
/** One tx carries the whole launch: the per-tx ceiling (measured 477,473 CU on devnet, v1-world programs). */
export const SINGLE_TX_COMPUTE_UNITS = TX_MAX_COMPUTE_UNITS;
/**
 * Loaded-accounts-data-size limit. v1 has NO default: unset = 0 = MaxLoadedAccountsDataSizeExceeded.
 * Measured ~2.70-2.77 MB (wrapper program data dominates); 8 MiB leaves ~3x headroom for the v2.1
 * programs (unmeasured) and is far under the 64 MiB ceiling.
 */
export const SINGLE_TX_LOADED_ACCOUNTS_BYTES = 8 * 1024 * 1024;
/** How long to keep resolving an unknown send outcome after the blockhash expires. */
const STATUS_POLL_MS = 1_500;

/** `NEXT_PUBLIC_LAUNCH_SINGLE_TX` (auto|on|off; 1/true/0/false). Read literally so Next inlines it. */
export function launchSingleTxModeFromEnv(raw: string | undefined = process.env.NEXT_PUBLIC_LAUNCH_SINGLE_TX): TxV1Mode {
  return parseTxV1Mode(raw, "auto");
}

export type SingleTxGateReason = "v21-flag-off" | "mode-off" | "not-p3" | "wallet-no-v1" | "cluster-no-v1" | "use";

/**
 * Whether to attempt the single-transaction launch. Cheap checks first: with the v2.1 flag off or the
 * mode off it returns before touching the wallet or the RPC, so the batched path runs exactly as before.
 */
export async function singleTxLaunchGate(i: {
  v21Enabled: boolean;
  mode: TxV1Mode;
  p3: boolean;
  walletSupportsV1: () => boolean;
  clusterSupportsV1: () => Promise<boolean>;
}): Promise<SingleTxGateReason> {
  if (!i.v21Enabled) return "v21-flag-off";
  if (i.mode === "off") return "mode-off";
  if (!i.p3) return "not-p3";
  if (!i.walletSupportsV1()) return "wallet-no-v1";
  if (!(await i.clusterSupportsV1())) return "cluster-no-v1";
  return "use";
}

/** On-chain status of the launch signature, as the resolver needs it. */
export type LaunchSigStatus = { kind: "confirmed" } | { kind: "failed"; err: unknown } | { kind: "pending" } | { kind: "not-found" };

/** Everything with side effects, injected (the hook passes RPC/wallet/route-backed functions). */
export interface SingleTxLaunchDeps {
  /** simulateV1 of the wire (sigVerify off). Throws on an RPC-level failure. */
  simulate: (wire: Uint8Array) => Promise<V1SimulationResult>;
  /** POST the message to the keeper co-sign route; resolves the keeper's 64-byte signature. */
  keeperSign: (message: Uint8Array) => Promise<Uint8Array>;
  /** ONE wallet prompt: sign the (pre-signed) wire, return the wallet's signed wire. */
  walletSign: (wire: Uint8Array) => Promise<Uint8Array>;
  /** sendTransaction of the final wire. */
  send: (wire: Uint8Array) => Promise<string>;
  /** Status of a signature (throws on RPC failure). */
  status: (signature: string) => Promise<LaunchSigStatus>;
  /** Current block height (throws on RPC failure). */
  blockHeight: () => Promise<number>;
  /** Whether the slab account exists (throws on RPC failure). */
  slabExists: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface SingleTxLaunchInput {
  payer: PublicKey;
  slab: PublicKey;
  /** The batched launch's instructions concatenated in tx order (singleTxInstructionPlan). */
  instructions: readonly TransactionInstruction[];
  /** Fresh keypairs that sign (slab, vault-LP portfolio, matcher ctx, stake mint, stake vault). */
  localSigners: readonly Keypair[];
  /** The keeper (oracle-authority delegate) when the launch is keeper-priced, else null. */
  keeper: PublicKey | null;
  programs: LaunchPrograms;
  blockhash: string;
  lastValidBlockHeight: number;
  priorityMicroLamportsPerCu: number;
  /** Upper bound on resolving an unknown outcome (default 150 s). */
  resolveTimeoutMs?: number;
}

export interface SingleTxStats {
  bytes: number;
  accounts: number;
  signers: number;
  instructions: number;
  unitsConsumed?: number;
  loadedAccountsDataSize?: number;
}

export type SingleTxStage = "plan" | "compile" | "simulate" | "keeper" | "wallet" | "send" | "confirm";

export type SingleTxOutcome =
  | { status: "landed"; signature: string; stats: SingleTxStats }
  | { status: "fallback"; stage: SingleTxStage; reason: string }
  | { status: "refused"; stage: SingleTxStage; reason: string; logs?: string[] }
  | { status: "unknown"; signature: string; reason: string };

/** A preflight refusal: the node simulated the signed tx and did NOT broadcast it (JSON-RPC -32002). */
export function isPreflightRefusal(err: unknown): boolean {
  // The JSON-RPC code first (V1RpcError from lib/tx-v1/rpc). A transport failure is never one: the tx may
  // have been accepted, so it must go to the outcome resolver, whatever its text says.
  if (err instanceof V1TransportError) return false;
  if (typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "number") {
    return (err as { code: number }).code === -32002;
  }
  const m = err instanceof Error ? err.message : String(err);
  return /-32002|Transaction simulation failed/i.test(m);
}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e));

/** Compile the launch message (exported for tests and the opt-in devnet simulation script). */
export function compileSingleTxLaunch(i: Pick<SingleTxLaunchInput, "payer" | "instructions" | "blockhash" | "priorityMicroLamportsPerCu">): CompiledV1Message {
  return compileV1Message({
    payer: i.payer,
    instructions: i.instructions,
    recentBlockhash: i.blockhash,
    config: {
      computeUnitLimit: SINGLE_TX_COMPUTE_UNITS,
      loadedAccountsDataSizeLimit: SINGLE_TX_LOADED_ACCOUNTS_BYTES,
      heapSizeBytes: SINGLE_TX_HEAP_BYTES,
      priorityFeeLamports: priorityFeeLamportsFromMicroPerCu(Math.max(0, Math.floor(i.priorityMicroLamportsPerCu)), SINGLE_TX_COMPUTE_UNITS),
    },
  });
}

export async function attemptSingleTxLaunch(i: SingleTxLaunchInput, d: SingleTxLaunchDeps): Promise<SingleTxOutcome> {
  // 1. Structure: the same rules the keeper route enforces. A violation is our own bug: nothing was
  //    signed, so the batched path (which never needed these cross-tx rules) takes over.
  const violations = launchBundleViolations(neutralFromInstructions(i.payer, i.instructions), {
    programs: i.programs,
    payer: i.payer.toBase58(),
    slab: i.slab.toBase58(),
    keeper: i.keeper ? i.keeper.toBase58() : null,
  });
  if (violations.length) return { status: "fallback", stage: "plan", reason: `launch bundle failed its structural check: ${violations[0]}` };

  // 2. Compile (throws past 4,096 B / 64 accounts / 64 ixs / 12 signers).
  let compiled: CompiledV1Message;
  try {
    compiled = compileSingleTxLaunch(i);
  } catch (e) {
    return { status: "fallback", stage: "compile", reason: msgOf(e) };
  }
  const stats: SingleTxStats = {
    bytes: compiled.txBytes,
    accounts: compiled.accountKeys.length,
    signers: compiled.numRequiredSignatures,
    instructions: i.instructions.length,
  };

  // 3. Simulate the EXACT message before anyone signs. Program error -> refuse (no prompt, no fallback:
  //    the batched path would hit the same error mid-way and leave a half-built market).
  let sim: V1SimulationResult;
  try {
    sim = await d.simulate(signV1Message(compiled, []));
  } catch (e) {
    return { status: "fallback", stage: "simulate", reason: isTxV1FormatRejection(e) ? `the RPC does not accept v1 transactions: ${msgOf(e)}` : `simulation unavailable: ${msgOf(e)}` };
  }
  if (sim.err) return { status: "refused", stage: "simulate", reason: `simulation failed: ${JSON.stringify(sim.err)}`, logs: sim.logs };
  stats.unitsConsumed = sim.unitsConsumed;
  stats.loadedAccountsDataSize = sim.loadedAccountsDataSize;

  // 4. Keeper co-sign of this exact message (the route validates it first). Verified locally too.
  const preSigned = signV1Message(compiled, i.localSigners.filter((k) => compiled.accountKeys.slice(0, compiled.numRequiredSignatures).some((a) => a.equals(k.publicKey))));
  if (i.keeper) {
    let sig: Uint8Array;
    try {
      sig = await d.keeperSign(compiled.message);
    } catch (e) {
      return { status: "fallback", stage: "keeper", reason: `keeper co-sign refused the single transaction: ${msgOf(e)}` };
    }
    const slot = compiled.accountKeys.findIndex((k, n) => n < compiled.numRequiredSignatures && k.equals(i.keeper!));
    if (slot < 0 || sig.length !== 64 || !ed25519.verify(sig, compiled.message, i.keeper.toBytes())) {
      return { status: "fallback", stage: "keeper", reason: "the keeper co-signature does not verify" };
    }
    preSigned.set(sig, compiled.message.length + slot * 64);
  }

  // 5. ONE wallet prompt. A decline is final and always wins (L-5: never re-prompt a user who said no).
  //    Only a genuine "this wallet cannot read v1" failure, or a wallet that altered the message, falls
  //    back to the batched path (nothing was sent). Any other wallet error is refused as-is.
  let wire: Uint8Array;
  try {
    const walletSigned = await d.walletSign(preSigned);
    wire = assembleSignedV1(compiled, preSigned, walletSigned);
  } catch (e) {
    if (isUserRejection(e)) return { status: "refused", stage: "wallet", reason: "you declined the launch transaction" };
    if (e instanceof WalletAlteredMessageError || isV1WalletSigningFailure(e)) {
      return { status: "fallback", stage: "wallet", reason: `the wallet could not sign the single transaction: ${msgOf(e)}` };
    }
    return { status: "refused", stage: "wallet", reason: `the wallet failed to sign the launch transaction: ${msgOf(e)}` };
  }
  const signature = v1TransactionSignature(wire);

  // 6. Send. A format rejection is a refusal to accept the bytes at all (nothing can land). Anything
  //    else (timeout, network) is UNKNOWN and goes to the resolver, never straight to a fallback.
  try {
    await d.send(wire);
  } catch (e) {
    if (isTxV1FormatRejection(e)) return { status: "fallback", stage: "send", reason: `the RPC refused the v1 transaction: ${msgOf(e)}` };
    // Preflight ran the signed tx and refused it: nothing was broadcast, and it is a program error.
    if (isPreflightRefusal(e)) return { status: "refused", stage: "send", reason: `the network refused the launch transaction: ${msgOf(e)}` };
    return resolveOutcome(i, d, signature, stats, `send did not return: ${msgOf(e)}`);
  }
  return resolveOutcome(i, d, signature, stats, null);
}

/**
 * Confirm, or settle an unknown outcome. Order: signature status; once the blockhash has expired
 * (block height > lastValidBlockHeight) a missing signature is final, cross-checked by the slab account
 * (the tx is atomic: the slab exists iff it landed). Any RPC failure that prevents a definite answer
 * ends as `unknown` (never a re-launch).
 */
async function resolveOutcome(i: SingleTxLaunchInput, d: SingleTxLaunchDeps, signature: string, stats: SingleTxStats, sendError: string | null): Promise<SingleTxOutcome> {
  const deadline = d.now() + (i.resolveTimeoutMs ?? 150_000);
  let rpcFailures = 0;
  for (;;) {
    try {
      const s = await d.status(signature);
      if (s.kind === "confirmed") return { status: "landed", signature, stats };
      if (s.kind === "failed") return { status: "refused", stage: "confirm", reason: `the launch transaction failed on chain (nothing was created): ${JSON.stringify(s.err)}` };
      if (s.kind === "not-found") {
        const height = await d.blockHeight();
        if (height > i.lastValidBlockHeight) {
          // Expired: it can no longer land. Re-check the status once more (RPC lag) and the slab.
          const again = await d.status(signature);
          if (again.kind === "confirmed") return { status: "landed", signature, stats };
          if (again.kind === "failed") return { status: "refused", stage: "confirm", reason: `the launch transaction failed on chain (nothing was created): ${JSON.stringify(again.err)}` };
          if (again.kind === "not-found") {
            if (await d.slabExists()) return { status: "landed", signature, stats };
            return { status: "fallback", stage: sendError ? "send" : "confirm", reason: `the single transaction expired without landing${sendError ? ` (${sendError})` : ""}` };
          }
        }
      }
    } catch {
      rpcFailures += 1;
    }
    if (d.now() > deadline) {
      return { status: "unknown", signature, reason: `could not confirm the launch transaction${rpcFailures ? ` (${rpcFailures} RPC failures)` : ""}` };
    }
    await d.sleep(STATUS_POLL_MS);
  }
}
