/*
 * LOCAL ADAPTER PORT, not original code: verbatim from percolator-sdk feat/tx-v1 @ 4752e204 (#401 + security
 * review SDK-1..5, src/runtime/txv1.ts), with only the `./tx.js` import retargeted at the installed
 * @percolatorct/sdk root. Delete when @percolatorct/sdk ships it and point ./index.ts at the package.
 * Do not edit here; fix upstream in percolator-sdk.
 */
/**
 * Solana v1 transactions (SIMD-0385 message format, SIMD-0296 4,096-byte limit).
 *
 * Why this module exists: `@solana/web3.js` 1.x can only DESERIALIZE v1 (1.99.0+;
 * `MessageV1.serialize()` throws), so the SDK carries its own small, dependency-light
 * encoder. The wire layout below is taken from the SIMD-0385 text and verified against
 * Agave through `simulateTransaction` on devnet and mainnet (see
 * percolator-ops/ledger/tx-v1-adoption-2026-10-05.md):
 *
 * ```
 * 0x81                         version byte
 * u8 u8 u8                     numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
 * u32 LE                       config mask (bit0+bit1 priority fee, bit2 CU limit,
 *                              bit3 loaded-accounts-data-size limit, bit4 heap size)
 * [u8; 32]                     lifetime specifier (recent blockhash)
 * u8                           numInstructions
 * u8                           numAddresses
 * [[u8; 32]]                   addresses
 * config values                priority fee u64 LE (TOTAL lamports), CU u32, loaded u32, heap u32
 *                              (present iff the mask bit is set, in bit order)
 * [(u8,u8,u16 LE)]             per instruction: programIdIndex, numAccounts, numDataBytes
 * payloads                     per instruction: account indices then data
 * [[u8; 64]]                   signatures (AFTER the message, one per required signer)
 * ```
 *
 * Differences that matter to callers:
 * - ComputeBudget instructions are IGNORED in v1. Budget goes into the config mask.
 * - Unset CU limit and unset loaded-accounts-data-size limit are 0, and 0 loaded size makes
 *   the tx fail with `MaxLoadedAccountsDataSizeExceeded` (verified). This module always sets both.
 * - The priority fee is a TOTAL in lamports, not micro-lamports per CU. Use
 *   {@link priorityFeeLamportsFromMicroPerCu} to convert.
 * - No address lookup tables. Every account is a 32-byte address in the message.
 * - The Percolator wrapper needs a 128 KiB heap on every transaction (#176). In v1 that is the
 *   heap-size config bit. THIS MODULE DOES NOT SET IT FOR YOU: `heapSizeBytes` (or `heapBytes` in a
 *   {@link BudgetParams}) must be passed explicitly, usually {@link V17_WRAPPER_HEAP_FRAME_BYTES}.
 *   A wrapper tx without it runs with the 32 KiB default and fails (fail-safe, not silent corruption).
 *   Use {@link wrapperV1Budget} to get the wrapper-correct budget.
 * - `priorityFeeLamports` is capped by {@link MAX_PRIORITY_FEE_LAMPORTS} (default 0.01 SOL) in the encoder;
 *   raising it needs an explicit `maxPriorityFeeLamports`.
 * - `sendV1` uses `connection.sendRawTransaction`, so the Connection's own fetch middleware, headers and any
 *   dry-run guard installed on it apply. `simulateV1` goes through the Connection's JSON-RPC transport when it
 *   exposes one (read-only) and only falls back to a raw `fetch` of `rpcEndpoint` (which does NOT see
 *   custom headers/middleware) when it does not. Never hand `sendGroupsAdaptive` a connection whose send guard
 *   you rely on without a `sender` that applies the same guard.
 *
 * @module
 */
import { ed25519 } from "@noble/curves/ed25519";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Transaction,
} from "@solana/web3.js";
import { V17_WRAPPER_HEAP_FRAME_BYTES } from "@percolatorct/sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** First byte of every v1 transaction (SIMD-0385: `129`). */
export const TX_V1_VERSION_BYTE = 0x81;
/** Maximum serialized v1 transaction size (SIMD-0296). */
export const TX_V1_MAX_BYTES = 4096;
/** Maximum serialized legacy / v0 transaction size (IPv6 MTU 1280 - 48 header bytes). */
export const TX_LEGACY_MAX_BYTES = 1232;
/** Maximum addresses (accounts) in one v1 transaction. */
export const TX_V1_MAX_ADDRESSES = 64;
/** Maximum instructions in one v1 transaction. */
export const TX_V1_MAX_INSTRUCTIONS = 64;
/** Maximum signatures in one v1 transaction. */
export const TX_V1_MAX_SIGNATURES = 12;
/** Per-transaction compute unit ceiling (unchanged in v1). */
export const TX_MAX_COMPUTE_UNITS = 1_400_000;
/** Default per-transaction loaded-accounts-data-size ceiling (64 MiB). */
export const TX_MAX_LOADED_ACCOUNTS_DATA_BYTES = 64 * 1024 * 1024;
/** Heap-size bounds in v1 (SIMD-0385): multiple of 1 KiB in [32 KiB, 256 KiB]. */
export const TX_V1_MIN_HEAP_BYTES = 32 * 1024;
export const TX_V1_MAX_HEAP_BYTES = 256 * 1024;
/**
 * Feature-gate account of Transaction v1 (SIMD-0385 + SIMD-0296). The account exists and holds
 * `Some(activation_slot)` once active (verified on devnet and mainnet-beta, 2026-10-05).
 */
export const TX_V1_FEATURE_ID = new PublicKey("txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL");
/**
 * Hard ceiling for the v1 priority fee, in TOTAL lamports (0.01 SOL). The fee is a total, not a per-CU price, so
 * a caller that passes a micro-lamports/CU price as lamports overpays by up to 6 orders of magnitude. The encoder
 * refuses anything above this unless the caller passes an explicit `maxPriorityFeeLamports`.
 */
export const MAX_PRIORITY_FEE_LAMPORTS = 10_000_000n;
/** Signature length. */
const SIG_LEN = 64;

const CFG_PRIORITY_FEE = 0b00011;
const CFG_COMPUTE_UNIT_LIMIT = 0b00100;
const CFG_LOADED_ACCOUNTS_DATA_SIZE = 0b01000;
const CFG_HEAP_SIZE = 0b10000;

/** Transaction wire formats the helper can emit. */
export type TxFormat = "v1" | "v0" | "legacy";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * The v1 transaction config (replaces ComputeBudget instructions).
 *
 * `computeUnitLimit` is required: an unset limit is 0 in v1 and the transaction cannot run.
 */
export interface V1Config {
  /** Requested compute unit limit, 1..{@link TX_MAX_COMPUTE_UNITS}. */
  computeUnitLimit: number;
  /**
   * Requested loaded-accounts-data-size limit in bytes, 1..64 MiB. Defaults to 64 MiB, the legacy
   * default, so behaviour matches a legacy transaction that sets no limit.
   */
  loadedAccountsDataSizeLimit?: number;
  /**
   * TOTAL priority fee in lamports (not micro-lamports per CU). Omit or 0 for none.
   * See {@link priorityFeeLamportsFromMicroPerCu}.
   */
  priorityFeeLamports?: bigint | number;
  /**
   * Ceiling for `priorityFeeLamports`. Default {@link MAX_PRIORITY_FEE_LAMPORTS}. Pass a higher value only
   * deliberately (an explicit, reviewed override); it is itself bounded by u64.
   */
  maxPriorityFeeLamports?: bigint | number;
  /**
   * Heap size in bytes (multiple of 1024 in [32768, 262144]). Omit for the 32 KiB default.
   * Every Percolator wrapper transaction needs 131072 ({@link V17_WRAPPER_HEAP_FRAME_BYTES}).
   */
  heapSizeBytes?: number;
}

/**
 * Convert a legacy micro-lamports-per-CU price into the v1 total-lamports priority fee.
 * Legacy charged `price * cuLimit / 1e6` (rounded up) on the REQUESTED limit, so the total is the same.
 *
 * @param microLamportsPerCu - Compute unit price in micro-lamports.
 * @param computeUnitLimit - The requested compute unit limit.
 * @returns Total priority fee in lamports (rounded up).
 * @example
 * priorityFeeLamportsFromMicroPerCu(50_000, 400_000) // 20_000n
 */
export function priorityFeeLamportsFromMicroPerCu(
  microLamportsPerCu: number | bigint,
  computeUnitLimit: number | bigint,
): bigint {
  for (const [n, v] of [["price", microLamportsPerCu], ["compute unit limit", computeUnitLimit]] as const) {
    if (typeof v === "number" && (!Number.isFinite(v) || !Number.isInteger(v))) throw new Error(`${n} must be a finite integer`);
  }
  const price = BigInt(microLamportsPerCu);
  const cu = BigInt(computeUnitLimit);
  if (price < 0n || cu < 0n) throw new Error("price and compute unit limit must be non-negative");
  return (price * cu + 999_999n) / 1_000_000n;
}

function validateConfig(cfg: V1Config): {
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
  priorityFeeLamports: bigint;
  heapSizeBytes: number | null;
} {
  const cu = cfg.computeUnitLimit;
  if (!Number.isInteger(cu) || cu < 1 || cu > TX_MAX_COMPUTE_UNITS) {
    throw new Error(`computeUnitLimit must be an integer in [1, ${TX_MAX_COMPUTE_UNITS}]`);
  }
  const loaded = cfg.loadedAccountsDataSizeLimit ?? TX_MAX_LOADED_ACCOUNTS_DATA_BYTES;
  if (!Number.isInteger(loaded) || loaded < 1 || loaded > TX_MAX_LOADED_ACCOUNTS_DATA_BYTES) {
    throw new Error(`loadedAccountsDataSizeLimit must be an integer in [1, ${TX_MAX_LOADED_ACCOUNTS_DATA_BYTES}]`);
  }
  for (const [n, v] of [["priorityFeeLamports", cfg.priorityFeeLamports], ["maxPriorityFeeLamports", cfg.maxPriorityFeeLamports]] as const) {
    if (typeof v === "number" && (!Number.isFinite(v) || !Number.isInteger(v))) throw new Error(`${n} must be a finite integer`);
  }
  const fee = BigInt(cfg.priorityFeeLamports ?? 0);
  if (fee < 0n || fee > 0xffff_ffff_ffff_ffffn) throw new Error("priorityFeeLamports must fit u64");
  const feeCap = BigInt(cfg.maxPriorityFeeLamports ?? MAX_PRIORITY_FEE_LAMPORTS);
  if (feeCap < 0n || feeCap > 0xffff_ffff_ffff_ffffn) throw new Error("maxPriorityFeeLamports must fit u64");
  if (fee > feeCap) {
    throw new Error(
      `priorityFeeLamports ${fee} exceeds the ceiling ${feeCap} lamports (the v1 fee is a TOTAL, not a per-CU price); ` +
        "pass an explicit maxPriorityFeeLamports if this is intended",
    );
  }
  let heap: number | null = null;
  if (cfg.heapSizeBytes !== undefined && cfg.heapSizeBytes !== 0) {
    const h = cfg.heapSizeBytes;
    if (!Number.isInteger(h) || h % 1024 !== 0 || h < TX_V1_MIN_HEAP_BYTES || h > TX_V1_MAX_HEAP_BYTES) {
      throw new Error(`heapSizeBytes must be a multiple of 1024 in [${TX_V1_MIN_HEAP_BYTES}, ${TX_V1_MAX_HEAP_BYTES}]`);
    }
    heap = h;
  }
  return {
    computeUnitLimit: cu,
    loadedAccountsDataSizeLimit: loaded,
    priorityFeeLamports: fee,
    heapSizeBytes: heap,
  };
}

// ---------------------------------------------------------------------------
// Message compilation + serialization
// ---------------------------------------------------------------------------

interface KeyMeta {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

/** Result of compiling instructions for v1. */
export interface CompiledV1Message {
  /** Message bytes (what signers sign), no signatures. */
  message: Uint8Array;
  /** Address table in message order; the first `numRequiredSignatures` are signers. */
  accountKeys: PublicKey[];
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  /** Serialized size including `numRequiredSignatures * 64` signature bytes. */
  txBytes: number;
}

function writeU32(out: number[], n: number): void {
  out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
}
function writeU64(out: number[], n: bigint): void {
  for (let i = 0n; i < 8n; i++) out.push(Number((n >> (8n * i)) & 0xffn));
}

/**
 * Compile instructions into a v1 message.
 *
 * Account ordering follows the legacy rule: writable signers (payer first), readonly signers,
 * writable non-signers, readonly non-signers. Program ids are readonly non-signers unless the
 * same key is also used as a writable account.
 *
 * @param params.payer - Fee payer (first signer, writable).
 * @param params.instructions - Instructions, in execution order. ComputeBudget instructions are rejected: they are ignored by v1 and would silently drop the budget.
 * @param params.recentBlockhash - Lifetime specifier (base58 blockhash).
 * @param params.config - v1 config (compute budget).
 * @returns The compiled message and its accounting.
 * @throws If any v1 limit is violated (64 addresses, 64 instructions, 12 signers, 4096 bytes).
 * @example
 * const c = compileV1Message({ payer, instructions: [ix], recentBlockhash, config: { computeUnitLimit: 200_000, heapSizeBytes: 131072 } });
 */
export function compileV1Message(params: {
  payer: PublicKey;
  instructions: readonly TransactionInstruction[];
  recentBlockhash: string;
  config: V1Config;
}): CompiledV1Message {
  const { payer, instructions, recentBlockhash } = params;
  const cfg = validateConfig(params.config);

  if (instructions.length === 0) throw new Error("v1: at least one instruction is required");
  if (instructions.length > TX_V1_MAX_INSTRUCTIONS) {
    throw new Error(`v1: ${instructions.length} instructions exceeds the limit of ${TX_V1_MAX_INSTRUCTIONS}`);
  }
  for (const ix of instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      throw new Error("v1: ComputeBudget instructions are ignored by v1; pass the budget in `config` instead");
    }
  }

  const metas = new Map<string, KeyMeta>();
  const upsert = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): void => {
    const k = pubkey.toBase58();
    const prev = metas.get(k);
    if (prev) {
      prev.isSigner ||= isSigner;
      prev.isWritable ||= isWritable;
    } else {
      metas.set(k, { pubkey, isSigner, isWritable });
    }
  };
  upsert(payer, true, true);
  for (const ix of instructions) {
    for (const m of ix.keys) upsert(m.pubkey, m.isSigner, m.isWritable);
  }
  // Program ids: readonly, non-signer unless already seen with stronger flags.
  for (const ix of instructions) upsert(ix.programId, false, false);
  // Agave rejects a program at index 0 (the payer) and demotes writable program ids; @solana/kit refuses both.
  // Match the stricter encoder so the two never disagree.
  for (const ix of instructions) {
    const m = metas.get(ix.programId.toBase58())!;
    if (ix.programId.equals(payer)) throw new Error("v1: a program id may not be the fee payer");
    if (m.isWritable || m.isSigner) throw new Error(`v1: program id ${ix.programId.toBase58()} is also used as a writable or signer account`);
  }

  const all = [...metas.values()];
  const payerKey = payer.toBase58();
  const rest = all.filter((m) => m.pubkey.toBase58() !== payerKey);
  const wSigners = [metas.get(payerKey)!, ...rest.filter((m) => m.isSigner && m.isWritable)];
  const rSigners = rest.filter((m) => m.isSigner && !m.isWritable);
  const wNon = rest.filter((m) => !m.isSigner && m.isWritable);
  const rNon = rest.filter((m) => !m.isSigner && !m.isWritable);
  const ordered = [...wSigners, ...rSigners, ...wNon, ...rNon];

  if (ordered.length > TX_V1_MAX_ADDRESSES) {
    throw new Error(`v1: ${ordered.length} accounts exceeds the limit of ${TX_V1_MAX_ADDRESSES}`);
  }
  const numRequiredSignatures = wSigners.length + rSigners.length;
  if (numRequiredSignatures > TX_V1_MAX_SIGNATURES) {
    throw new Error(`v1: ${numRequiredSignatures} signatures exceeds the limit of ${TX_V1_MAX_SIGNATURES}`);
  }
  const index = new Map(ordered.map((m, i) => [m.pubkey.toBase58(), i] as const));

  const out: number[] = [];
  out.push(TX_V1_VERSION_BYTE, numRequiredSignatures, rSigners.length, rNon.length);
  let mask = CFG_COMPUTE_UNIT_LIMIT | CFG_LOADED_ACCOUNTS_DATA_SIZE;
  if (cfg.priorityFeeLamports > 0n) mask |= CFG_PRIORITY_FEE;
  if (cfg.heapSizeBytes !== null) mask |= CFG_HEAP_SIZE;
  writeU32(out, mask);
  out.push(...new PublicKey(recentBlockhash).toBytes());
  out.push(instructions.length, ordered.length);
  for (const m of ordered) out.push(...m.pubkey.toBytes());
  if (cfg.priorityFeeLamports > 0n) writeU64(out, cfg.priorityFeeLamports);
  writeU32(out, cfg.computeUnitLimit);
  writeU32(out, cfg.loadedAccountsDataSizeLimit);
  if (cfg.heapSizeBytes !== null) writeU32(out, cfg.heapSizeBytes);

  const payloads: number[] = [];
  for (const ix of instructions) {
    if (ix.keys.length > 255) throw new Error("v1: an instruction has more than 255 accounts");
    if (ix.data.length > 0xffff) throw new Error("v1: instruction data exceeds 65535 bytes");
    out.push(index.get(ix.programId.toBase58())!, ix.keys.length, ix.data.length & 0xff, ix.data.length >>> 8);
    for (const m of ix.keys) payloads.push(index.get(m.pubkey.toBase58())!);
    for (const b of ix.data) payloads.push(b);
  }
  const message = new Uint8Array(out.length + payloads.length);
  message.set(out, 0);
  // Push in chunks-safe way (avoid spreading huge arrays into out).
  message.set(payloads, out.length);

  const txBytes = message.length + numRequiredSignatures * SIG_LEN;
  if (txBytes > TX_V1_MAX_BYTES) {
    throw new Error(`v1: transaction is ${txBytes} bytes, exceeding the ${TX_V1_MAX_BYTES}-byte limit`);
  }
  return {
    message,
    accountKeys: ordered.map((m) => m.pubkey),
    numRequiredSignatures,
    numReadonlySigned: rSigners.length,
    numReadonlyUnsigned: rNon.length,
    txBytes,
  };
}

/**
 * Sign a compiled v1 message with the given keypairs and return the wire bytes.
 * Slots with no matching keypair are left zero-filled (a partially-signed tx, to be completed by a wallet).
 *
 * @param compiled - Output of {@link compileV1Message}.
 * @param signers - Keypairs for any of the required signer slots.
 * @returns The serialized v1 transaction (message then signatures).
 * @example
 * const wire = signV1Message(compiled, [payerKeypair]);
 */
export function signV1Message(compiled: CompiledV1Message, signers: readonly Keypair[]): Uint8Array {
  const sigs = new Uint8Array(compiled.numRequiredSignatures * SIG_LEN);
  for (const kp of signers) {
    const slot = compiled.accountKeys.findIndex((k, i) => i < compiled.numRequiredSignatures && k.equals(kp.publicKey));
    if (slot < 0) throw new Error(`signer ${kp.publicKey.toBase58()} is not a required signer of this transaction`);
    sigs.set(ed25519.sign(compiled.message, kp.secretKey.slice(0, 32)), slot * SIG_LEN);
  }
  const wire = new Uint8Array(compiled.message.length + sigs.length);
  wire.set(compiled.message, 0);
  wire.set(sigs, compiled.message.length);
  return wire;
}

/**
 * Decode the transaction signature (the first signature, base58) of v1 wire bytes.
 *
 * @param wire - Serialized v1 transaction.
 * @returns The base58 transaction id.
 */
export function v1TransactionSignature(wire: Uint8Array): string {
  const nSigs = wire[1]!;
  const start = wire.length - nSigs * SIG_LEN;
  return encodeBase58(wire.subarray(start, start + SIG_LEN));
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Measurement across formats
// ---------------------------------------------------------------------------

/** Compute-budget parameters shared by every format. */
export interface BudgetParams {
  computeUnitLimit: number;
  /** Legacy-style price in micro-lamports per CU; converted to total lamports for v1. */
  priorityMicroLamportsPerCu?: number;
  /** Heap in bytes; 0/undefined = none. Wrapper txs: {@link V17_WRAPPER_HEAP_FRAME_BYTES}. */
  heapBytes?: number;
  /** v1 only: loaded accounts data size limit. */
  loadedAccountsDataSizeLimit?: number;
  /** v1 only: override of {@link MAX_PRIORITY_FEE_LAMPORTS}. Leave unset unless a higher fee is deliberate. */
  maxPriorityFeeLamports?: bigint | number;
}

/**
 * Budget for a transaction that touches the Percolator wrapper: the 128 KiB heap is always requested
 * ({@link V17_WRAPPER_HEAP_FRAME_BYTES}, #176). Everything else is passed through.
 *
 * @param b - Budget without the heap.
 * @returns Budget with `heapBytes` set to the wrapper's heap.
 * @example
 * packInstructionGroups(groups, { format: "v1", payer, budget: wrapperV1Budget({}) });
 */
export function wrapperV1Budget(b: Omit<BudgetParams, "computeUnitLimit" | "heapBytes"> = {}): Omit<BudgetParams, "computeUnitLimit"> {
  return { ...b, heapBytes: V17_WRAPPER_HEAP_FRAME_BYTES };
}

/** Placeholder blockhash used only for size measurement (any 32 bytes). */
const MEASURE_BLOCKHASH = "11111111111111111111111111111111";

/** v1 config derived from format-neutral budget params. */
export function v1ConfigFromBudget(b: BudgetParams): V1Config {
  const price = b.priorityMicroLamportsPerCu;
  if (price !== undefined && (!Number.isFinite(price) || !Number.isInteger(price) || price < 0)) {
    throw new Error("priorityMicroLamportsPerCu must be a non-negative finite integer (NaN/fractions are refused, not treated as 0)");
  }
  const fee = price ? priorityFeeLamportsFromMicroPerCu(price, b.computeUnitLimit) : 0n;
  return {
    computeUnitLimit: b.computeUnitLimit,
    priorityFeeLamports: fee,
    ...(b.maxPriorityFeeLamports !== undefined ? { maxPriorityFeeLamports: b.maxPriorityFeeLamports } : {}),
    heapSizeBytes: b.heapBytes ? b.heapBytes : undefined,
    loadedAccountsDataSizeLimit: b.loadedAccountsDataSizeLimit,
  };
}

/** Legacy / v0 ComputeBudget prelude equivalent to a budget. */
export function computeBudgetInstructions(b: BudgetParams): TransactionInstruction[] {
  const out: TransactionInstruction[] = [];
  if (b.heapBytes) out.push(ComputeBudgetProgram.requestHeapFrame({ bytes: b.heapBytes }));
  out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: b.computeUnitLimit }));
  if (b.priorityMicroLamportsPerCu) {
    out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: b.priorityMicroLamportsPerCu }));
  }
  return out;
}

/**
 * Exact serialized size of `instructions` in the given format, including the budget (instructions for
 * legacy/v0, config bytes for v1) and one 64-byte signature per required signer.
 * v0 is measured without address lookup tables.
 *
 * @param format - Wire format.
 * @param payer - Fee payer.
 * @param instructions - Payload instructions (no ComputeBudget).
 * @param budget - Budget.
 * @returns Size in bytes.
 * @throws If the instructions cannot be compiled into that format at all.
 * @example
 * measureTxBytes("v1", payer, [ix], { computeUnitLimit: 400_000, heapBytes: 131072 }) // e.g. 301
 */
export function measureTxBytes(
  format: TxFormat,
  payer: PublicKey,
  instructions: readonly TransactionInstruction[],
  budget: BudgetParams,
): number {
  if (format === "v1") {
    // Measure without enforcing the 4096 cap so callers can see by how much they overshoot.
    return compileV1Unbounded(payer, instructions, v1ConfigFromBudget(budget)).txBytes;
  }
  const ixs = [...computeBudgetInstructions(budget), ...instructions];
  if (format === "legacy") {
    const tx = new Transaction();
    tx.add(...ixs);
    tx.feePayer = payer;
    tx.recentBlockhash = MEASURE_BLOCKHASH;
    const msg = tx.compileMessage();
    return msg.serialize().length + 1 + msg.header.numRequiredSignatures * SIG_LEN;
  }
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: MEASURE_BLOCKHASH, instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(msg).serialize().length;
}

function compileV1Unbounded(payer: PublicKey, ixs: readonly TransactionInstruction[], cfg: V1Config): CompiledV1Message {
  // Same compile with the final byte-limit check disabled (but the structural limits kept).
  try {
    return compileV1Message({ payer, instructions: ixs, recentBlockhash: MEASURE_BLOCKHASH, config: cfg });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const hit = /transaction is (\d+) bytes/.exec(m);
    if (hit) {
      return { message: new Uint8Array(0), accountKeys: [], numRequiredSignatures: 0, numReadonlySigned: 0, numReadonlyUnsigned: 0, txBytes: Number(hit[1]) };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Size-aware packing
// ---------------------------------------------------------------------------

/**
 * One atomic unit of work for {@link packInstructionGroups}: its instructions are never split across
 * transactions (e.g. one market's PushAuthMark, or a crank + its dependent ix).
 */
export interface PackGroup<T = unknown> {
  /** Instructions of this unit, in order. */
  instructions: readonly TransactionInstruction[];
  /** Estimated compute units this unit consumes. */
  computeUnits: number;
  /** Caller payload carried through to the plan (market id, etc). */
  tag?: T;
}

/** One planned transaction. */
export interface PackedTx<T = unknown> {
  groups: PackGroup<T>[];
  instructions: TransactionInstruction[];
  /** Sum of the groups' compute units. */
  computeUnits: number;
  /** Exact serialized size of this transaction in the planned format. */
  bytes: number;
  /** Distinct accounts incl. programs and payer. */
  accounts: number;
}

/** Limits for {@link packInstructionGroups}. Defaults come from the format. */
export interface PackOptions {
  format: TxFormat;
  payer: PublicKey;
  /** Maximum bytes (default 4096 for v1, 1232 otherwise). */
  maxBytes?: number;
  /** Compute-unit ceiling per tx (default 1,400,000). */
  maxComputeUnits?: number;
  /** Max groups per tx (default unbounded). */
  maxGroups?: number;
  /** Safety margin subtracted from maxBytes (default 0). */
  byteMargin?: number;
  /** Fixed compute-unit overhead added to the limit (default 0). */
  budget?: Omit<BudgetParams, "computeUnitLimit">;
  /** Extra CU headroom multiplier applied to the summed estimate for the limit (default 1). */
  cuHeadroom?: number;
}

/**
 * Greedy, order-preserving, size-aware packing: groups are appended to the current transaction until
 * adding the next would exceed the byte limit, the account limit (64), the instruction limit (64),
 * the compute-unit ceiling, or `maxGroups`; then a new transaction starts.
 *
 * Sizes are exact (the real compile is used on every step), so a returned plan never exceeds
 * `maxBytes`. A single group that alone exceeds a limit throws, since it could never be sent.
 *
 * @param groups - Atomic units, in priority order.
 * @param opts - Format, payer and limits.
 * @returns Planned transactions, covering every group exactly once, in order.
 * @throws If a single group alone does not fit.
 * @example
 * const plan = packInstructionGroups(markets.map((m) => ({ instructions: [pushIx(m)], computeUnits: 12_000, tag: m })), { format: "v1", payer });
 * plan.length // transactions needed
 */
export function packInstructionGroups<T = unknown>(
  groups: readonly PackGroup<T>[],
  opts: PackOptions,
): PackedTx<T>[] {
  const maxBytes = (opts.maxBytes ?? (opts.format === "v1" ? TX_V1_MAX_BYTES : TX_LEGACY_MAX_BYTES)) - (opts.byteMargin ?? 0);
  const maxCu = opts.maxComputeUnits ?? TX_MAX_COMPUTE_UNITS;
  const headroom = opts.cuHeadroom ?? 1;
  const budgetFor = (cu: number): BudgetParams => ({
    ...(opts.budget ?? {}),
    computeUnitLimit: Math.min(TX_MAX_COMPUTE_UNITS, Math.max(1, Math.ceil(cu * headroom))),
  });

  /** Returns bytes, or null when a structural limit (accounts/ix/signers) is violated. */
  const fits = (gs: readonly PackGroup<T>[], cu: number): { bytes: number; accounts: number; ixs: TransactionInstruction[] } | null => {
    const ixs = gs.flatMap((g) => g.instructions);
    const keys = new Set<string>([opts.payer.toBase58()]);
    for (const ix of ixs) {
      keys.add(ix.programId.toBase58());
      for (const m of ix.keys) keys.add(m.pubkey.toBase58());
    }
    const accountCap = TX_V1_MAX_ADDRESSES;
    if (keys.size > accountCap) return null;
    if (opts.format === "v1" && ixs.length > TX_V1_MAX_INSTRUCTIONS) return null;
    if (cu > maxCu) return null;
    if (opts.maxGroups !== undefined && gs.length > opts.maxGroups) return null;
    let bytes: number;
    try {
      bytes = measureTxBytes(opts.format, opts.payer, ixs, budgetFor(cu));
    } catch {
      return null;
    }
    if (bytes > maxBytes) return null;
    return { bytes, accounts: keys.size, ixs };
  };

  const plan: PackedTx<T>[] = [];
  let cur: PackGroup<T>[] = [];
  let curCu = 0;
  for (const g of groups) {
    const tryCu = curCu + g.computeUnits;
    if (cur.length > 0 && fits([...cur, g], tryCu)) {
      cur.push(g);
      curCu = tryCu;
      continue;
    }
    if (cur.length > 0) {
      const f = fits(cur, curCu)!;
      plan.push({ groups: cur, instructions: f.ixs, computeUnits: curCu, bytes: f.bytes, accounts: f.accounts });
    }
    cur = [g];
    curCu = g.computeUnits;
    if (!fits(cur, curCu)) {
      throw new Error("packInstructionGroups: a single group does not fit within the limits of the selected format");
    }
  }
  if (cur.length > 0) {
    const f = fits(cur, curCu)!;
    plan.push({ groups: cur, instructions: f.ixs, computeUnits: curCu, bytes: f.bytes, accounts: f.accounts });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Feature detection and mode
// ---------------------------------------------------------------------------

/** `TX_V1` flag: `auto` = use v1 when the cluster supports it, `on` = require v1, `off` = never. */
export type TxV1Mode = "auto" | "on" | "off";

/**
 * Parse a `TX_V1` style flag. Unknown / empty values fall back to `fallback`.
 *
 * @param raw - Raw env string.
 * @param fallback - Value for missing/invalid input (default `"auto"`).
 * @returns The mode.
 */
export function parseTxV1Mode(raw: string | undefined | null, fallback: TxV1Mode = "auto"): TxV1Mode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "auto" || v === "on" || v === "off") return v;
  if (v === "1" || v === "true") return "on";
  if (v === "0" || v === "false") return "off";
  return fallback;
}

/**
 * True when feature-gate account data records an activation (`Option<u64>` = `Some`).
 *
 * @param data - Raw account data of the feature account (9 bytes when set or unset).
 * @returns Whether the feature is active.
 */
export function isFeatureAccountActive(data: Uint8Array | null | undefined): boolean {
  return !!data && data.length >= 9 && data[0] === 1;
}

/** Minimal connection surface the detector needs (a web3.js `Connection` satisfies it). */
export interface V1DetectConnection {
  getAccountInfo(pubkey: PublicKey): Promise<{ data: Uint8Array } | null>;
}

const detectCache = new WeakMap<object, { at: number; ok: boolean }>();

/**
 * Detect whether the cluster behind `connection` has Transaction v1 active, by reading the feature-gate
 * account (read-only). The result is cached per connection for `ttlMs`. An RPC failure is reported as
 * `false` (so callers fall back to v0/legacy) and is NOT cached.
 *
 * A positive result says the CLUSTER accepts v1; it does not prove that every RPC node, sender service or
 * wallet in front of it does. Use the send-time fallback ({@link isTxV1FormatRejection}) for that.
 *
 * @param connection - Connection (or a stub with `getAccountInfo`).
 * @param ttlMs - Cache lifetime, default 10 minutes.
 * @returns true if active.
 * @example
 * if (await detectTxV1Support(connection)) { /* build v1 *\/ }
 */
export async function detectTxV1Support(connection: V1DetectConnection, ttlMs = 10 * 60_000): Promise<boolean> {
  const hit = detectCache.get(connection);
  if (hit && Date.now() - hit.at < ttlMs) return hit.ok;
  try {
    const info = await connection.getAccountInfo(TX_V1_FEATURE_ID);
    const ok = isFeatureAccountActive(info?.data);
    detectCache.set(connection, { at: Date.now(), ok });
    return ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the format to use for a `TX_V1` mode.
 *
 * @param mode - `auto|on|off`.
 * @param clusterSupportsV1 - From {@link detectTxV1Support}.
 * @param fallback - Format when v1 is not used (default `"legacy"`).
 * @returns The format. In `on` mode with an unsupporting cluster this throws instead of silently downgrading.
 */
export function resolveTxFormat(mode: TxV1Mode, clusterSupportsV1: boolean, fallback: Exclude<TxFormat, "v1"> = "legacy"): TxFormat {
  if (mode === "off") return fallback;
  if (clusterSupportsV1) return "v1";
  if (mode === "on") throw new Error("TX_V1=on but the cluster does not report Transaction v1 as active");
  return fallback;
}

/** A JSON-RPC level error from {@link sendV1} / {@link simulateV1}, carrying the node's error code. */
export class V1RpcError extends Error {
  /** JSON-RPC error code (e.g. -32602 invalid params, -32015 unsupported version, -32002 simulation failed). */
  readonly code: number;
  /** RPC method that failed. */
  readonly method: string;
  constructor(method: string, code: number, message: string) {
    super(`RPC ${method} failed: ${code} ${message}`);
    this.name = "V1RpcError";
    this.method = method;
    this.code = code;
  }
}

/** JSON-RPC codes that mean "the node could not accept this wire format" (never an on-chain outcome). */
const FORMAT_REJECTION_CODES: ReadonlySet<number> = new Set([
  -32602, // invalid params: undecodable / too large / failed to sanitize / bad signature size
  -32015, // transaction version not supported by the requesting client / node
]);

function rpcErrorCode(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "number") return c;
    // web3.js SolanaJSONRPCError keeps the node's code on `.code`; a wrapped cause may carry it instead.
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== err) return rpcErrorCode(cause);
  }
  return undefined;
}

/**
 * Classify an error from a v1 send/simulate as "the node/cluster rejected the v1 FORMAT" (as opposed to the
 * transaction failing on-chain, or the transport failing). Only these may trigger a repack-and-retry as
 * v0/legacy; a program error or a network error must never cause a resend.
 *
 * Classification is by the JSON-RPC error CODE (`V1RpcError.code`, or the `.code` of a web3.js
 * `SolanaJSONRPCError`): only {@link FORMAT_REJECTION_CODES}. Arbitrary message text is never enough, so a
 * transport error whose text merely mentions "too large" or "not supported" after the node may already have
 * accepted the tx cannot cause a double send.
 *
 * @param err - Thrown error.
 * @returns true if the failure is a format rejection.
 */
export function isTxV1FormatRejection(err: unknown): boolean {
  const code = rpcErrorCode(err);
  return code !== undefined && FORMAT_REJECTION_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Raw RPC helpers (web3.js 1.x cannot serialize or simulate v1 itself)
// ---------------------------------------------------------------------------

/** Result of a raw v1 simulation. */
export interface V1SimulationResult {
  err: unknown;
  logs: string[];
  unitsConsumed?: number;
  loadedAccountsDataSize?: number;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Options for raw JSON-RPC calls. */
export interface RawRpcOptions {
  /** Extra headers (e.g. Origin for a key-restricted endpoint). */
  headers?: Record<string, string>;
  /** Injected fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** The Connection's own JSON-RPC transport (web3.js 1.x internal; honours custom fetch/headers/middleware). */
interface ConnectionTransport {
  _rpcRequest?: (method: string, args: unknown[]) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;
}

async function rawRpc(connection: Connection, method: string, params: unknown[], o: RawRpcOptions): Promise<unknown> {
  let json: { result?: unknown; error?: { code: number; message: string } };
  const transport = (connection as unknown as ConnectionTransport)._rpcRequest;
  if (typeof transport === "function" && o.fetchImpl === undefined && o.headers === undefined) {
    // Same transport (headers, fetch middleware, agents) as every other call on this Connection.
    json = await transport.call(connection, method, params);
  } else {
    const f = o.fetchImpl ?? fetch;
    const res = await f(connection.rpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    json = (await res.json()) as typeof json;
  }
  if (json.error) throw new V1RpcError(method, json.error.code, json.error.message);
  return json.result;
}

/**
 * Simulate v1 wire bytes (read-only). `sigVerify` is off so an unsigned/partially signed message can be
 * simulated, and the blockhash is replaced so a stale one does not mask the real result.
 *
 * @param connection - Connection; its own JSON-RPC transport is used when it exposes one, else a raw fetch of `rpcEndpoint`.
 * @param wire - Serialized v1 transaction.
 * @param o - Raw RPC options (passing `fetchImpl`/`headers` forces the raw fetch path).
 * @returns Simulation outcome.
 * @throws On JSON-RPC level errors (decode/sanitize failures), which {@link isTxV1FormatRejection} classifies.
 */
export async function simulateV1(connection: Connection, wire: Uint8Array, o: RawRpcOptions = {}): Promise<V1SimulationResult> {
  const r = (await rawRpc(connection, "simulateTransaction", [toBase64(wire), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }], o)) as {
    value: { err: unknown; logs?: string[] | null; unitsConsumed?: number; loadedAccountsDataSize?: number };
  };
  return { err: r.value.err, logs: r.value.logs ?? [], unitsConsumed: r.value.unitsConsumed, loadedAccountsDataSize: r.value.loadedAccountsDataSize };
}

/**
 * Send v1 wire bytes. Returns the signature string reported by the node.
 *
 * @param connection - Connection; sent through `connection.sendRawTransaction` (its transport and send guards apply).
 * @param wire - Serialized, fully signed v1 transaction.
 * @param opts - `skipPreflight` / `maxRetries` plus raw RPC options.
 * @returns Transaction signature.
 * @throws On any JSON-RPC error. Format rejections satisfy {@link isTxV1FormatRejection}.
 */
export async function sendV1(
  connection: Connection,
  wire: Uint8Array,
  opts: RawRpcOptions & { skipPreflight?: boolean; maxRetries?: number; preflightCommitment?: "processed" | "confirmed" | "finalized" } = {},
): Promise<string> {
  if (opts.fetchImpl === undefined && opts.headers === undefined) {
    // web3.js `sendRawTransaction` only base64-encodes the bytes (it never parses them), so it carries v1 fine and,
    // unlike a raw fetch, goes through the Connection's own transport and any send guard (e.g. a dry-run override).
    return connection.sendRawTransaction(wire, {
      skipPreflight: opts.skipPreflight ?? false,
      preflightCommitment: opts.preflightCommitment ?? "confirmed",
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    });
  }
  return (await rawRpc(
    connection,
    "sendTransaction",
    [toBase64(wire), { encoding: "base64", skipPreflight: opts.skipPreflight ?? false, preflightCommitment: opts.preflightCommitment ?? "confirmed", ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}) }],
    opts,
  )) as string;
}

// ---------------------------------------------------------------------------
// Wallet capability
// ---------------------------------------------------------------------------

/** Structural subset of a wallet-adapter `Adapter`. */
export interface WalletVersionInfo {
  /** `null`/`undefined` = legacy only (wallet-adapter convention). */
  supportedTransactionVersions?: ReadonlySet<unknown> | null;
}

/**
 * True only when the wallet explicitly advertises v1 (`supportedTransactionVersions` contains `1`).
 * Wallets must advertise only after they can fully parse and sign v1; an absent or legacy/0-only set is
 * treated as "no", which is the safe direction (the caller then uses v0/legacy).
 *
 * @param wallet - A wallet-adapter `Adapter` (or any object with `supportedTransactionVersions`).
 * @returns Whether v1 user-signing may be attempted.
 * @example
 * const useV1 = walletSupportsV1(wallet?.adapter);
 */
export function walletSupportsV1(wallet: WalletVersionInfo | null | undefined): boolean {
  const s = wallet?.supportedTransactionVersions;
  return !!s && s.has(1);
}

// ---------------------------------------------------------------------------
// Adaptive send: pack, send as v1 when supported, repack + fall back on a format rejection
// ---------------------------------------------------------------------------

/** Outcome of one transaction sent by {@link sendGroupsAdaptive}. */
export interface AdaptiveTxResult<T = unknown> {
  /** Format actually used. */
  format: TxFormat;
  /** Tags of the groups carried by this tx (from {@link PackGroup.tag}). */
  tags: (T | undefined)[];
  /** Exact serialized bytes. */
  bytes: number;
  /** Signature when the send was accepted by the node. */
  signature?: string;
  /** Error message when the send failed (on-chain failures included). */
  error?: string;
  /** True when this tx was produced by repacking after a v1 rejection. */
  afterFallback: boolean;
}

/** Aggregate result. */
export interface AdaptiveResult<T = unknown> {
  results: AdaptiveTxResult<T>[];
  /** Number of transactions sent (accepted or failed). */
  txCount: number;
  /** Format the cycle started in. */
  initialFormat: TxFormat;
  /** True if a v1 rejection forced a fallback mid-run. */
  fellBack: boolean;
  /** Transactions the same groups would have needed in the fallback format (for observability). */
  baselineTxCount: number;
}

/** Parameters for {@link sendGroupsAdaptive}. */
export interface AdaptiveSendParams<T = unknown> {
  connection: Connection;
  /** Fee payer + any other signers (payer first). */
  signers: readonly Keypair[];
  groups: readonly PackGroup<T>[];
  mode: TxV1Mode;
  /** Format used when v1 is off / unsupported / rejected. Default `legacy`. */
  fallbackFormat?: Exclude<TxFormat, "v1">;
  /** Budget template (CU is derived per tx from the packed groups). */
  budget?: Omit<BudgetParams, "computeUnitLimit">;
  /** CU headroom multiplier over the summed estimate. Default 1.2. */
  cuHeadroom?: number;
  /** Max groups per tx in addition to byte/CU/account limits. */
  maxGroups?: number;
  /** Override cluster detection (tests / known clusters). */
  clusterSupportsV1?: boolean;
  /**
   * Custom transport. Receives the signed wire bytes and the format; must return the signature or throw.
   * Use this to route through Helius Sender or another sender. Default: raw `sendTransaction`.
   */
  sender?: (wire: Uint8Array, format: TxFormat) => Promise<string>;
  /** Called after each tx attempt. */
  onTx?: (r: AdaptiveTxResult<T>) => void;
  /** Stop after the first failed (non-format) send. Default false: remaining txs are still attempted. */
  stopOnError?: boolean;
}

/**
 * Plan and send `groups` in as few transactions as the format allows.
 *
 * - `mode` `off` -> fallback format; `auto` -> v1 iff {@link detectTxV1Support}; `on` -> v1, throws when the cluster reports it inactive.
 * - If a v1 send is rejected for FORMAT reasons ({@link isTxV1FormatRejection}), the remaining groups are repacked
 *   in the fallback format and sending continues. On-chain failures never trigger a fallback or a resend.
 *
 * Failure atomicity is per transaction, exactly as before: a failed tx fails its groups together.
 *
 * @param p - See {@link AdaptiveSendParams}.
 * @returns Per-transaction results and the tx-count comparison.
 * @example
 * const out = await sendGroupsAdaptive({ connection, signers: [keeper], groups, mode: parseTxV1Mode(process.env.TX_V1), budget: { heapBytes: 131072, priorityMicroLamportsPerCu: 50_000 } });
 * console.log(out.txCount, "vs", out.baselineTxCount);
 */
export async function sendGroupsAdaptive<T = unknown>(p: AdaptiveSendParams<T>): Promise<AdaptiveResult<T>> {
  const payerKp = p.signers[0];
  if (!payerKp) throw new Error("sendGroupsAdaptive: at least one signer is required");
  const payer = payerKp.publicKey;
  const fallback = p.fallbackFormat ?? "legacy";
  const cuHeadroom = p.cuHeadroom ?? 1.2;
  const supports = p.mode === "off" ? false : (p.clusterSupportsV1 ?? (await detectTxV1Support(p.connection)));
  const initial = resolveTxFormat(p.mode, supports, fallback);

  const pack = (gs: readonly PackGroup<T>[], format: TxFormat) =>
    packInstructionGroups(gs, { format, payer, budget: p.budget, cuHeadroom, maxGroups: p.maxGroups });

  const baselineTxCount = initial === "v1" ? pack(p.groups, fallback).length : pack(p.groups, initial).length;
  const send = p.sender ?? (async (wire: Uint8Array, format: TxFormat): Promise<string> => {
    if (format === "v1") return sendV1(p.connection, wire);
    return p.connection.sendRawTransaction(wire, { skipPreflight: false, preflightCommitment: "confirmed" });
  });

  const results: AdaptiveTxResult<T>[] = [];
  let format: TxFormat = initial;
  let fellBack = false;
  let remaining: readonly PackGroup<T>[] = p.groups;
  let plan = pack(remaining, format);
  let i = 0;
  while (i < plan.length) {
    const tx = plan[i]!;
    const { blockhash } = await p.connection.getLatestBlockhash("confirmed");
    const cu = Math.min(TX_MAX_COMPUTE_UNITS, Math.max(1, Math.ceil(tx.computeUnits * cuHeadroom)));
    const budget: BudgetParams = { ...(p.budget ?? {}), computeUnitLimit: cu };
    let wire: Uint8Array;
    if (format === "v1") {
      wire = signV1Message(compileV1Message({ payer, instructions: tx.instructions, recentBlockhash: blockhash, config: v1ConfigFromBudget(budget) }), p.signers);
    } else {
      const ixs = [...computeBudgetInstructions(budget), ...tx.instructions];
      if (format === "legacy") {
        const t = new Transaction();
        t.add(...ixs);
        t.feePayer = payer;
        t.recentBlockhash = blockhash;
        t.sign(...p.signers);
        wire = t.serialize();
      } else {
        const vt = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
        vt.sign([...p.signers]);
        wire = vt.serialize();
      }
    }
    try {
      const signature = await send(wire, format);
      const r: AdaptiveTxResult<T> = { format, tags: tx.groups.map((g) => g.tag), bytes: wire.length, signature, afterFallback: fellBack };
      results.push(r);
      p.onTx?.(r);
      i++;
    } catch (e) {
      if (format === "v1" && isTxV1FormatRejection(e) && p.mode !== "on") {
        // Format rejection: repack everything not yet accepted (this tx onward) in the fallback format.
        fellBack = true;
        format = fallback;
        remaining = plan.slice(i).flatMap((t) => t.groups);
        plan = pack(remaining, format);
        i = 0;
        continue;
      }
      const message = e instanceof Error ? e.message : String(e);
      const r: AdaptiveTxResult<T> = { format, tags: tx.groups.map((g) => g.tag), bytes: wire.length, error: message, afterFallback: fellBack };
      results.push(r);
      p.onTx?.(r);
      if (p.stopOnError) break;
      i++;
    }
  }
  return { results, txCount: results.length, initialFormat: initial, fellBack, baselineTxCount };
}
