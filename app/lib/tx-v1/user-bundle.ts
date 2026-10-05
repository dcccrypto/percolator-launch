/**
 * User-signed bundles in the smallest number of transactions, using Solana v1 transactions
 * (SIMD-0385 / SIMD-0296: 4,096-byte packets, no ALTs, budget in a config mask) ONLY when it helps
 * and only when the connected wallet can sign them; otherwise the exact legacy path the app already
 * uses for batches (`buildBatchTx` + `signAllCompat` + `broadcastSignedTx`, lib/tx.ts).
 *
 * Two entry points:
 *  - `planUserBundle` (pure, synchronous): packs instruction groups for the fallback format and, when
 *    allowed, for v1; picks v1 only when the gate passes AND v1 needs fewer transactions (or the
 *    bundle cannot be sent in the fallback format at all). A CU-bound bundle (same tx count in both
 *    formats) stays on the fallback format: v1 would add wallet risk and no benefit.
 *  - `sendUserBundle`: plan -> (v1) compile, simulate, sign ALL in one wallet call, verify, send,
 *    confirm; on a v1 FORMAT problem that happens before anything was submitted (RPC cannot decode
 *    v1, the wallet cannot sign v1, the wallet altered the message), re-plan and send the fallback
 *    plan once. Never after a transaction was submitted; never on a program error.
 *
 * Gate (all must hold for v1): `NEXT_PUBLIC_TX_V1` (auto|on|off, default auto) is not `off`; the
 * wallet advertises v1 on `solana:signTransaction` (`resolveRawTxSigner(...).supportsV1`); the
 * cluster reports the v1 feature active (`detectTxV1Support`); and in `auto`, v1 reduces the
 * transaction count. `on` drops only the last condition (for testing a v1-capable wallet), never the
 * wallet or cluster checks: a user is never sent down a path their wallet cannot sign.
 *
 * Budget: every transaction carries the wrapper's 128 KiB heap frame (#176), a CU limit of
 * `ceil(sum(group.computeUnits) * cuHeadroom)` capped at 1.4M, and the app's priority fee
 * (micro-lamports/CU for legacy; the same total in lamports for v1).
 */
import {
  Keypair,
  PublicKey,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import {
  TX_MAX_COMPUTE_UNITS,
  compileV1Message,
  detectTxV1Support,
  isTxV1FormatRejection,
  measureTxBytes,
  packInstructionGroups,
  parseTxV1Mode,
  priorityFeeLamportsFromMicroPerCu,
  signV1Message,
  type CompiledV1Message,
  type PackGroup,
  type PackedTx,
  type TxFormat,
  type TxV1Mode,
  type V1SimulationResult,
} from "@/lib/v21/sdk";
import {
  SimulationRefusal,
  broadcastSignedTx,
  buildBatchTx,
  getFreshBlockhash,
  clampPriorityFee,
  getPriorityFee,
  pollConfirmation,
  presimulateOrThrow,
  signAllCompat,
} from "@/lib/tx";
import { getNetwork } from "@/lib/config";
import {
  isUserRejection,
  isV1WalletSigningFailure,
  resolveRawTxSigner,
  type RawTxSigner,
  type SolanaChainId,
} from "./wallet-raw-signer";
import { sendV1ViaProxy, simulateV1ViaProxy } from "./rpc";

/** Heap frame every Percolator wrapper transaction requests (#176); matches lib/tx.ts. */
export const USER_BUNDLE_HEAP_BYTES = 131_072;
/** Default CU headroom over the summed group estimates. */
export const USER_BUNDLE_CU_HEADROOM = 1.2;
const SIG_LEN = 64;

/** Fallback (non-v1) formats. The app sends legacy everywhere today. */
export type FallbackFormat = Exclude<TxFormat, "v1">;

/** `NEXT_PUBLIC_TX_V1` (auto|on|off; also 1/true/0/false). Unknown/empty -> `auto`. */
export function txV1ModeFromEnv(raw: string | undefined = process.env.NEXT_PUBLIC_TX_V1): TxV1Mode {
  return parseTxV1Mode(raw, "auto");
}

/** Wallet Standard chain id for the app's network. */
export function walletChainForNetwork(): SolanaChainId {
  return getNetwork() === "mainnet" ? "solana:mainnet" : "solana:devnet";
}

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

/** Why the plan uses the format it uses. */
export type UserBundleFormatReason =
  | "flag-off"
  | "wallet-no-v1"
  | "cluster-no-v1"
  | "no-benefit"
  | "fewer-transactions"
  | "fallback-cannot-fit"
  | "forced-on";

export interface PlanUserBundleInput<T = unknown> {
  /** Atomic units, in execution order; a group is never split across transactions. */
  groups: readonly PackGroup<T>[];
  /** Fee payer = the wallet. */
  payer: PublicKey;
  mode: TxV1Mode;
  /** `resolveRawTxSigner(...)?.supportsV1`. */
  walletV1: boolean;
  /** `detectTxV1Support(connection)`. */
  clusterV1: boolean;
  /** Default `legacy` (what lib/tx.ts sends). */
  fallbackFormat?: FallbackFormat;
  /** Priority price used for size accounting (the bytes do not depend on its value, only on presence). */
  priorityMicroLamportsPerCu?: number;
  /** Default {@link USER_BUNDLE_CU_HEADROOM}. */
  cuHeadroom?: number;
  /** Extra cap on groups per transaction. */
  maxGroups?: number;
  /** Bytes to keep free per transaction (e.g. for repairs a sender may prepend). Default 0. */
  byteMargin?: number;
}

export interface FormatPlan<T = unknown> {
  format: TxFormat;
  txs: PackedTx<T>[];
}

export interface UserBundlePlan<T = unknown> {
  /** The format `sendUserBundle` will try first. */
  format: TxFormat;
  txs: PackedTx<T>[];
  reason: UserBundleFormatReason;
  /** The fallback-format plan, or null when the bundle cannot be sent in that format at all. */
  fallback: FormatPlan<T> | null;
  /** The v1 plan when it was computed (gate passed), else null. */
  v1: FormatPlan<T> | null;
}

/** A single group does not fit any format the wallet can use. */
export class BundleDoesNotFitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleDoesNotFitError";
  }
}

function packFor<T>(format: TxFormat, i: PlanUserBundleInput<T>): PackedTx<T>[] {
  return packInstructionGroups(i.groups, {
    format,
    payer: i.payer,
    budget: { heapBytes: USER_BUNDLE_HEAP_BYTES, priorityMicroLamportsPerCu: Math.max(1, i.priorityMicroLamportsPerCu ?? 1) },
    cuHeadroom: i.cuHeadroom ?? USER_BUNDLE_CU_HEADROOM,
    maxGroups: i.maxGroups,
    byteMargin: i.byteMargin,
  });
}

function tryPack<T>(format: TxFormat, i: PlanUserBundleInput<T>): PackedTx<T>[] | null {
  try {
    return packFor(format, i);
  } catch {
    return null;
  }
}

/**
 * Decide the format and pack the groups. Pure: no RPC, no wallet.
 *
 * @throws BundleDoesNotFitError when some group fits no usable format.
 */
export function planUserBundle<T = unknown>(i: PlanUserBundleInput<T>): UserBundlePlan<T> {
  if (i.groups.length === 0) throw new Error("planUserBundle: no instruction groups");
  const fallbackFormat = i.fallbackFormat ?? "legacy";
  const fbTxs = tryPack(fallbackFormat, i);
  const fallback: FormatPlan<T> | null = fbTxs ? { format: fallbackFormat, txs: fbTxs } : null;

  const gateReason: UserBundleFormatReason | null =
    i.mode === "off" ? "flag-off" : !i.walletV1 ? "wallet-no-v1" : !i.clusterV1 ? "cluster-no-v1" : null;
  if (gateReason) {
    if (!fallback) throw new BundleDoesNotFitError(`A transaction group does not fit a ${fallbackFormat} transaction and v1 is unavailable (${gateReason})`);
    return { format: fallbackFormat, txs: fallback.txs, reason: gateReason, fallback, v1: null };
  }

  const v1Txs = tryPack("v1", i);
  const v1: FormatPlan<T> | null = v1Txs ? { format: "v1", txs: v1Txs } : null;
  if (!v1) {
    if (!fallback) throw new BundleDoesNotFitError("A transaction group does not fit any transaction format");
    return { format: fallbackFormat, txs: fallback.txs, reason: "no-benefit", fallback, v1: null };
  }
  if (!fallback) return { format: "v1", txs: v1.txs, reason: "fallback-cannot-fit", fallback: null, v1 };
  if (v1.txs.length < fallback.txs.length) return { format: "v1", txs: v1.txs, reason: "fewer-transactions", fallback, v1 };
  if (i.mode === "on") return { format: "v1", txs: v1.txs, reason: "forced-on", fallback, v1 };
  return { format: fallbackFormat, txs: fallback.txs, reason: "no-benefit", fallback, v1 };
}

/** Size/count report for every format (measurement and diagnostics; v0 is without ALTs). */
export interface BundleFormatReport {
  format: TxFormat;
  /** null when some group fits no transaction of this format. */
  txCount: number | null;
  bytes: number[];
  accounts: number[];
  computeUnits: number[];
  /** Required signatures per transaction. */
  signers: number[];
}

/** Pack the same groups in legacy, v0 and v1 and report each. */
export function measureBundleFormats<T>(
  groups: readonly PackGroup<T>[],
  payer: PublicKey,
  opts: Pick<PlanUserBundleInput<T>, "priorityMicroLamportsPerCu" | "cuHeadroom" | "maxGroups" | "byteMargin"> = {},
): BundleFormatReport[] {
  const formats: TxFormat[] = ["legacy", "v0", "v1"];
  return formats.map((format) => {
    const txs = tryPack(format, { ...opts, groups, payer, mode: "on", walletV1: true, clusterV1: true });
    if (!txs) return { format, txCount: null, bytes: [], accounts: [], computeUnits: [], signers: [] };
    return {
      format,
      txCount: txs.length,
      bytes: txs.map((t) => t.bytes),
      accounts: txs.map((t) => t.accounts),
      computeUnits: txs.map((t) => t.computeUnits),
      signers: txs.map((t) => requiredSigners(payer, t.instructions)),
    };
  });
}

function requiredSigners(payer: PublicKey, ixs: readonly TransactionInstruction[]): number {
  const s = new Set<string>([payer.toBase58()]);
  for (const ix of ixs) for (const k of ix.keys) if (k.isSigner) s.add(k.pubkey.toBase58());
  return s.size;
}

// ---------------------------------------------------------------------------
// v1 wire: signature slots, verification, assembly
// ---------------------------------------------------------------------------

/** Split v1 wire bytes into message and signature slots (signatures trail the message). */
export function splitV1Wire(wire: Uint8Array): { message: Uint8Array; signatures: Uint8Array[] } {
  if (wire.length < 4 || wire[0] !== 0x81) throw new Error("not a v1 transaction");
  const n = wire[1]!;
  const msgLen = wire.length - n * SIG_LEN;
  if (msgLen <= 0) throw new Error("v1 transaction shorter than its signatures");
  const signatures = Array.from({ length: n }, (_, k) => wire.slice(msgLen + k * SIG_LEN, msgLen + (k + 1) * SIG_LEN));
  return { message: wire.slice(0, msgLen), signatures };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

/** The wallet changed the message it was asked to sign (e.g. injected an instruction). */
export class WalletAlteredMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletAlteredMessageError";
  }
}

/**
 * Combine the wallet's signed wire with our keypair signatures. The wallet's returned message must be
 * byte-identical to the one we compiled, and every signature slot must verify against it, or this
 * throws (nothing is ever sent unverified).
 */
export function assembleSignedV1(compiled: CompiledV1Message, preSigned: Uint8Array, walletSigned: Uint8Array): Uint8Array {
  let wallet: { message: Uint8Array; signatures: Uint8Array[] };
  try {
    wallet = splitV1Wire(walletSigned);
  } catch (e) {
    throw new WalletAlteredMessageError(`wallet returned a non-v1 transaction: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!bytesEqual(wallet.message, compiled.message) || wallet.signatures.length !== compiled.numRequiredSignatures) {
    throw new WalletAlteredMessageError("wallet returned a different v1 message than the one it was asked to sign");
  }
  const ours = splitV1Wire(preSigned).signatures;
  const zero = new Uint8Array(SIG_LEN);
  const out = new Uint8Array(compiled.message.length + compiled.numRequiredSignatures * SIG_LEN);
  out.set(compiled.message, 0);
  for (let k = 0; k < compiled.numRequiredSignatures; k++) {
    const sig = !bytesEqual(ours[k]!, zero) ? ours[k]! : wallet.signatures[k]!;
    if (!ed25519.verify(sig, compiled.message, compiled.accountKeys[k]!.toBytes())) {
      throw new WalletAlteredMessageError(`signature slot ${k} (${compiled.accountKeys[k]!.toBase58()}) does not verify`);
    }
    out.set(sig, compiled.message.length + k * SIG_LEN);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Why a v1 attempt was abandoned for the fallback plan (always before anything was submitted). */
export type V1FallbackReason =
  | "v1-simulation-rpc-failed"
  | "wallet-cannot-sign-v1"
  | "wallet-altered-message"
  | "rpc-rejected-v1-format";

/** Which transactions to simulate before the wallet opens. */
export type BundleSimulation = "all" | "first" | "none";

/** Everything with side effects, injectable (tests use fakes; defaults use `connection`). */
export interface UserBundleDeps {
  clusterSupportsV1: () => Promise<boolean>;
  getBlockhash: () => Promise<string>;
  getPriorityFee: () => Promise<number>;
  /** Throws `SimulationRefusal` on a program error. */
  simulateLegacy: (tx: Transaction) => Promise<void>;
  /** Throws on an RPC-level failure (incl. a v1 decode failure). */
  simulateV1: (wire: Uint8Array) => Promise<V1SimulationResult>;
  /** Wallet-signs legacy transactions (one approval when the wallet batches). */
  signLegacy: (txs: Transaction[]) => Promise<Transaction[]>;
  /** Broadcast + confirm a signed legacy transaction. */
  sendLegacy: (tx: Transaction) => Promise<string>;
  /** Broadcast v1 wire bytes (no confirmation). */
  sendV1: (wire: Uint8Array) => Promise<string>;
  confirm: (signature: string) => Promise<void>;
  /** Raw-bytes signer for v1 (null = none). */
  rawSigner: RawTxSigner | null;
}

/** The subset of the app's WalletApi the helper needs. */
export interface UserBundleWallet {
  publicKey: PublicKey | null;
  signTransaction?: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions?: (txs: Transaction[]) => Promise<Transaction[]>;
  /** WalletApi.wallet (wallet-adapter Wallet or Privy ConnectedStandardSolanaWallet). */
  wallet?: unknown;
}

export interface SendUserBundleParams<T = unknown> {
  connection: Connection;
  wallet: UserBundleWallet;
  groups: readonly PackGroup<T>[];
  /** Keypairs that must co-sign (new account keys, ...); each is applied only to txs that need it. */
  signers?: readonly Keypair[];
  /** Default: `txV1ModeFromEnv()`. */
  mode?: TxV1Mode;
  /** Default `"all"`. Use `"first"` when later transactions depend on earlier ones landing. */
  simulate?: BundleSimulation;
  fallbackFormat?: "legacy";
  cuHeadroom?: number;
  maxGroups?: number;
  byteMargin?: number;
  /** Observability: called with the plan before signing, and on a v1 fallback. */
  onPlan?: (plan: UserBundlePlan<T>) => void;
  onFallback?: (reason: V1FallbackReason, error: unknown) => void;
  /** Overrides (tests). */
  deps?: Partial<UserBundleDeps>;
}

export interface UserBundleResult<T = unknown> {
  /** Format the bundle was actually sent in. */
  format: TxFormat;
  /** One per transaction, in order. */
  signatures: string[];
  /** The plan that was executed (after a fallback: the fallback plan). */
  plan: UserBundlePlan<T>;
  /** Set when a v1 attempt was abandoned (before anything was submitted). */
  fellBack: { reason: V1FallbackReason; error: string } | null;
}

/** A send/confirm failed AFTER at least one transaction of the bundle was submitted. */
export class PartialBundleError extends Error {
  readonly signatures: string[];
  readonly failedIndex: number;
  constructor(message: string, signatures: string[], failedIndex: number, cause: unknown) {
    super(message, { cause });
    this.name = "PartialBundleError";
    this.signatures = signatures;
    this.failedIndex = failedIndex;
  }
}

class V1Fallback extends Error {
  constructor(readonly reason: V1FallbackReason, readonly original: unknown) {
    super(reason);
  }
}

function defaultDeps(connection: Connection, wallet: UserBundleWallet): UserBundleDeps {
  return {
    clusterSupportsV1: () => detectTxV1Support(connection),
    getBlockhash: () => getFreshBlockhash(connection),
    getPriorityFee: () => getPriorityFee(connection),
    simulateLegacy: (tx) => presimulateOrThrow(connection, tx),
    // Through ./rpc so a JSON-RPC format rejection keeps its code (V1RpcError) and a transport failure never
    // looks like one (V1TransportError; the SDK's default sendV1 passes a network failure through untyped).
    simulateV1: (wire) => simulateV1ViaProxy(connection, wire),
    signLegacy: (txs) => signAllCompat(wallet, txs),
    sendLegacy: (tx) => broadcastSignedTx(connection, tx),
    sendV1: (wire) => sendV1ViaProxy(connection, wire),
    confirm: (sig) => pollConfirmation(connection, sig),
    rawSigner: resolveRawTxSigner(wallet.wallet, wallet.publicKey, walletChainForNetwork()),
  };
}

function signersFor(signers: readonly Keypair[], required: readonly PublicKey[]): Keypair[] {
  return signers.filter((s) => required.some((k) => k.equals(s.publicKey)));
}

function cuLimitOf(tx: PackedTx<unknown>, headroom: number): number {
  return Math.min(TX_MAX_COMPUTE_UNITS, Math.max(1, Math.ceil(tx.computeUnits * headroom)));
}

function shouldSimulate(mode: BundleSimulation, index: number): boolean {
  return mode === "all" || (mode === "first" && index === 0);
}

/**
 * Plan, sign once, send and confirm a user bundle. See the module doc for the gate and fallback rules.
 *
 * @throws SimulationRefusal when a pre-sign simulation reports a program error (the wallet never opened).
 * @throws PartialBundleError when a send/confirm fails after an earlier transaction was submitted.
 * @throws The wallet's error on a user rejection (never retried).
 */
export async function sendUserBundle<T = unknown>(p: SendUserBundleParams<T>): Promise<UserBundleResult<T>> {
  const payer = p.wallet.publicKey;
  if (!payer) throw new Error("Wallet not connected");
  const d: UserBundleDeps = { ...defaultDeps(p.connection, p.wallet), ...(p.deps ?? {}) };
  const mode = p.mode ?? txV1ModeFromEnv();
  const headroom = p.cuHeadroom ?? USER_BUNDLE_CU_HEADROOM;
  const simulate = p.simulate ?? "all";
  const signers = p.signers ?? [];

  const walletV1 = mode !== "off" && !!d.rawSigner?.supportsV1;
  const clusterV1 = walletV1 ? await d.clusterSupportsV1() : false;
  // Clamp again here: `deps.getPriorityFee` is injectable, and the v1 total is derived from this price.
  const priorityFee = clampPriorityFee(await d.getPriorityFee());
  const planInput: PlanUserBundleInput<T> = {
    groups: p.groups,
    payer,
    mode,
    walletV1,
    clusterV1,
    fallbackFormat: p.fallbackFormat ?? "legacy",
    priorityMicroLamportsPerCu: priorityFee,
    cuHeadroom: headroom,
    maxGroups: p.maxGroups,
    byteMargin: p.byteMargin,
  };
  const plan = planUserBundle(planInput);
  p.onPlan?.(plan);

  if (plan.format === "v1" && d.rawSigner) {
    try {
      const signatures = await sendV1Plan(plan.txs, { payer, signers, priorityFee, headroom, simulate, d, rawSigner: d.rawSigner });
      return { format: "v1", signatures, plan, fellBack: null };
    } catch (e) {
      if (!(e instanceof V1Fallback)) throw e;
      p.onFallback?.(e.reason, e.original);
      if (!plan.fallback) throw e.original instanceof Error ? e.original : new Error(String(e.original));
      const fbPlan: UserBundlePlan<T> = { format: plan.fallback.format, txs: plan.fallback.txs, reason: plan.reason, fallback: plan.fallback, v1: plan.v1 };
      const signatures = await sendLegacyPlan(fbPlan.txs, { payer, signers, priorityFee, headroom, simulate, d });
      const msg = e.original instanceof Error ? e.original.message : String(e.original);
      return { format: fbPlan.format, signatures, plan: fbPlan, fellBack: { reason: e.reason, error: msg } };
    }
  }
  const signatures = await sendLegacyPlan(plan.txs, { payer, signers, priorityFee, headroom, simulate, d });
  return { format: plan.format, signatures, plan, fellBack: null };
}

interface SendCtx {
  payer: PublicKey;
  signers: readonly Keypair[];
  priorityFee: number;
  headroom: number;
  simulate: BundleSimulation;
  d: UserBundleDeps;
}

async function sendLegacyPlan<T>(txs: readonly PackedTx<T>[], c: SendCtx): Promise<string[]> {
  const blockhash = await c.d.getBlockhash();
  const built = txs.map((t) =>
    buildBatchTx({
      instructions: t.instructions,
      computeUnits: cuLimitOf(t, c.headroom),
      priorityFeeMicroLamports: c.priorityFee,
      blockhash,
      feePayer: c.payer,
    }),
  );
  for (let k = 0; k < built.length; k++) {
    if (shouldSimulate(c.simulate, k)) await c.d.simulateLegacy(built[k]!);
  }
  const signed = await c.d.signLegacy(built);
  // Keypair signatures AFTER the wallet (Privy can strip unknown signatures; lib/tx.ts does the same).
  signed.forEach((tx, k) => {
    const msg = built[k]!.compileMessage();
    const required = msg.accountKeys.slice(0, msg.header.numRequiredSignatures);
    const own = signersFor(c.signers, required);
    if (own.length > 0) tx.partialSign(...own);
  });
  const sigs: string[] = [];
  for (let k = 0; k < signed.length; k++) {
    try {
      sigs.push(await c.d.sendLegacy(signed[k]!));
    } catch (e) {
      if (k === 0) throw e;
      throw new PartialBundleError(`Transaction ${k + 1} of ${signed.length} failed after ${k} landed`, sigs, k, e);
    }
  }
  return sigs;
}

async function sendV1Plan<T>(txs: readonly PackedTx<T>[], c: SendCtx & { rawSigner: RawTxSigner }): Promise<string[]> {
  const blockhash = await c.d.getBlockhash();
  const compiled = txs.map((t) => {
    const cu = cuLimitOf(t, c.headroom);
    return compileV1Message({
      payer: c.payer,
      instructions: t.instructions,
      recentBlockhash: blockhash,
      config: {
        computeUnitLimit: cu,
        heapSizeBytes: USER_BUNDLE_HEAP_BYTES,
        priorityFeeLamports: priorityFeeLamportsFromMicroPerCu(c.priorityFee, cu),
      },
    });
  });
  const preSigned = compiled.map((m) => signV1Message(m, signersFor(c.signers, m.accountKeys.slice(0, m.numRequiredSignatures))));

  // Pre-sign simulation: a program error refuses (no wallet prompt, no fallback); a FORMAT rejection
  // (JSON-RPC -32602/-32015: the node cannot take v1) falls back before anything was signed. Any other
  // failure (network, proxy rate limit, upstream down) is thrown as-is: it says nothing about v1.
  for (let k = 0; k < preSigned.length; k++) {
    if (!shouldSimulate(c.simulate, k)) continue;
    let sim: V1SimulationResult;
    try {
      sim = await c.d.simulateV1(preSigned[k]!);
    } catch (e) {
      if (isTxV1FormatRejection(e)) throw new V1Fallback("v1-simulation-rpc-failed", e);
      throw e;
    }
    if (sim.err) throw new SimulationRefusal(sim.err, sim.logs, txs[k]!.instructions);
  }

  let walletSigned: Uint8Array[];
  try {
    walletSigned = await c.rawSigner.signRaw(preSigned);
  } catch (e) {
    if (isUserRejection(e)) throw e;
    if (isV1WalletSigningFailure(e)) throw new V1Fallback("wallet-cannot-sign-v1", e);
    throw e;
  }
  let wires: Uint8Array[];
  try {
    wires = compiled.map((m, k) => assembleSignedV1(m, preSigned[k]!, walletSigned[k]!));
  } catch (e) {
    throw new V1Fallback("wallet-altered-message", e);
  }

  const sigs: string[] = [];
  for (let k = 0; k < wires.length; k++) {
    let sig: string;
    try {
      sig = await c.d.sendV1(wires[k]!);
    } catch (e) {
      // Only the FIRST send may fall back, and only on a format rejection: nothing has landed.
      if (k === 0 && isTxV1FormatRejection(e)) throw new V1Fallback("rpc-rejected-v1-format", e);
      if (k === 0) throw e;
      throw new PartialBundleError(`Transaction ${k + 1} of ${wires.length} failed after ${k} landed`, sigs, k, e);
    }
    try {
      await c.d.confirm(sig);
    } catch (e) {
      if (k === 0) {
        // Submitted but unconfirmed: never resend; hand the signature back like broadcastSignedTx does.
        if (e instanceof Error) Object.assign(e, { signature: sig });
        throw e;
      }
      throw new PartialBundleError(`Transaction ${k + 1} of ${wires.length} did not confirm`, [...sigs, sig], k, e);
    }
    sigs.push(sig);
  }
  return sigs;
}

/** Re-exported so callers build groups without importing the SDK adapter directly. */
export type { PackGroup, PackedTx, TxFormat, TxV1Mode } from "@/lib/v21/sdk";
