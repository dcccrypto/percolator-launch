/**
 * Strict decoder for a Solana v1 transaction MESSAGE (SIMD-0385), the bytes every signer signs.
 *
 * Used where the app must trust what a message does before signing it: the keeper co-sign route
 * (app/api/playground/keeper-cosign) decodes the single-transaction launch message and validates it
 * before the keeper key signs. It is deliberately strict, so there is no parser differential between
 * what we validate and what the runtime executes:
 *  - version byte 0x81, every count and index in range, no duplicate addresses;
 *  - only the five defined config-mask bits (priority fee = bits 0+1 together, CU limit, loaded
 *    accounts data size, heap size); any other bit, or bit 0 without bit 1, is refused;
 *  - the message must END exactly after the last instruction payload (no trailing bytes);
 *  - re-encoding the decoded message must reproduce the input byte for byte.
 *
 * Layout (see lib/v21/sdk/txv1.ts, the SDK's encoder):
 *   0x81 | nReqSig u8 | nRoSigned u8 | nRoUnsigned u8 | mask u32 LE | blockhash [32]
 *   | nIx u8 | nAddr u8 | addr [32]*nAddr | config values (mask order) | (prog u8, nAcc u8, nData u16 LE)*nIx
 *   | per ix: account indexes then data
 */
import { PublicKey } from "@solana/web3.js";

export const V1_VERSION_BYTE = 0x81;
const MASK_FEE = 0b00011;
const MASK_CU = 0b00100;
const MASK_LOADED = 0b01000;
const MASK_HEAP = 0b10000;
const MASK_ALL = MASK_FEE | MASK_CU | MASK_LOADED | MASK_HEAP;

export interface DecodedV1Instruction {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
}

export interface DecodedV1Message {
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
  configMask: number;
  recentBlockhash: Uint8Array;
  accountKeys: PublicKey[];
  priorityFeeLamports: bigint | null;
  computeUnitLimit: number | null;
  loadedAccountsDataSizeLimit: number | null;
  heapSizeBytes: number | null;
  instructions: DecodedV1Instruction[];
}

export class V1DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V1DecodeError";
  }
}

class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}
  get offset(): number {
    return this.o;
  }
  private need(n: number): void {
    if (this.o + n > this.b.length) throw new V1DecodeError(`message truncated at byte ${this.o} (need ${n})`);
  }
  u8(): number {
    this.need(1);
    return this.b[this.o++]!;
  }
  u16(): number {
    this.need(2);
    const v = this.b[this.o]! | (this.b[this.o + 1]! << 8);
    this.o += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = (this.b[this.o]! | (this.b[this.o + 1]! << 8) | (this.b[this.o + 2]! << 16) | (this.b[this.o + 3]! << 24)) >>> 0;
    this.o += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this.b[this.o + i]!);
    this.o += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.b.slice(this.o, this.o + n);
    this.o += n;
    return out;
  }
}

/** Decode and validate a v1 message. Throws {@link V1DecodeError} on any deviation. */
export function decodeV1Message(message: Uint8Array): DecodedV1Message {
  const r = new Reader(message);
  if (r.u8() !== V1_VERSION_BYTE) throw new V1DecodeError("not a v1 message (version byte)");
  const numRequiredSignatures = r.u8();
  const numReadonlySigned = r.u8();
  const numReadonlyUnsigned = r.u8();
  const configMask = r.u32();
  if ((configMask & ~MASK_ALL) !== 0) throw new V1DecodeError(`unknown config-mask bits 0x${configMask.toString(16)}`);
  const feeBits = configMask & MASK_FEE;
  if (feeBits !== 0 && feeBits !== MASK_FEE) throw new V1DecodeError("priority-fee mask bits must be set together");
  const recentBlockhash = r.bytes(32);
  const nIx = r.u8();
  const nAddr = r.u8();
  if (nAddr === 0) throw new V1DecodeError("no addresses");
  if (numRequiredSignatures === 0 || numRequiredSignatures > nAddr) throw new V1DecodeError("bad signer count");
  if (numReadonlySigned >= numRequiredSignatures) throw new V1DecodeError("fee payer cannot be readonly");
  if (numReadonlyUnsigned > nAddr - numRequiredSignatures) throw new V1DecodeError("bad readonly-unsigned count");
  const accountKeys: PublicKey[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nAddr; i++) {
    const k = new PublicKey(r.bytes(32));
    const s = k.toBase58();
    if (seen.has(s)) throw new V1DecodeError(`duplicate address ${s}`);
    seen.add(s);
    accountKeys.push(k);
  }
  const priorityFeeLamports = feeBits ? r.u64() : null;
  const computeUnitLimit = configMask & MASK_CU ? r.u32() : null;
  const loadedAccountsDataSizeLimit = configMask & MASK_LOADED ? r.u32() : null;
  const heapSizeBytes = configMask & MASK_HEAP ? r.u32() : null;
  const heads: { prog: number; nAcc: number; nData: number }[] = [];
  for (let i = 0; i < nIx; i++) heads.push({ prog: r.u8(), nAcc: r.u8(), nData: r.u16() });
  const instructions: DecodedV1Instruction[] = [];
  for (const h of heads) {
    if (h.prog >= nAddr) throw new V1DecodeError(`program index ${h.prog} out of range`);
    if (h.prog === 0) throw new V1DecodeError("the fee payer cannot be a program");
    const accountIndexes: number[] = [];
    for (let j = 0; j < h.nAcc; j++) {
      const a = r.u8();
      if (a >= nAddr) throw new V1DecodeError(`account index ${a} out of range`);
      accountIndexes.push(a);
    }
    instructions.push({ programIdIndex: h.prog, accountIndexes, data: r.bytes(h.nData) });
  }
  if (r.offset !== message.length) throw new V1DecodeError(`${message.length - r.offset} trailing bytes after the last instruction`);
  const decoded: DecodedV1Message = {
    numRequiredSignatures,
    numReadonlySigned,
    numReadonlyUnsigned,
    configMask,
    recentBlockhash,
    accountKeys,
    priorityFeeLamports,
    computeUnitLimit,
    loadedAccountsDataSizeLimit,
    heapSizeBytes,
    instructions,
  };
  const again = encodeV1Message(decoded);
  if (again.length !== message.length || again.some((b, i) => b !== message[i])) {
    throw new V1DecodeError("message is not in canonical form");
  }
  return decoded;
}

/** Re-encode a decoded message (the canonical-form check; also used by tests to tamper messages). */
export function encodeV1Message(d: DecodedV1Message): Uint8Array {
  const out: number[] = [V1_VERSION_BYTE, d.numRequiredSignatures, d.numReadonlySigned, d.numReadonlyUnsigned];
  const u32 = (n: number): void => {
    out.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  };
  u32(d.configMask);
  out.push(...d.recentBlockhash);
  out.push(d.instructions.length, d.accountKeys.length);
  for (const k of d.accountKeys) out.push(...k.toBytes());
  if (d.priorityFeeLamports !== null) for (let i = 0n; i < 8n; i++) out.push(Number((d.priorityFeeLamports >> (8n * i)) & 0xffn));
  if (d.computeUnitLimit !== null) u32(d.computeUnitLimit);
  if (d.loadedAccountsDataSizeLimit !== null) u32(d.loadedAccountsDataSizeLimit);
  if (d.heapSizeBytes !== null) u32(d.heapSizeBytes);
  for (const ix of d.instructions) out.push(ix.programIdIndex, ix.accountIndexes.length, ix.data.length & 0xff, ix.data.length >>> 8);
  for (const ix of d.instructions) out.push(...ix.accountIndexes, ...ix.data);
  return Uint8Array.from(out);
}

/** Message-level signer flag (legacy rule, unchanged in v1). */
export function v1IsSigner(d: DecodedV1Message, i: number): boolean {
  return i < d.numRequiredSignatures;
}

/** Message-level writable flag (legacy rule, unchanged in v1). */
export function v1IsWritable(d: DecodedV1Message, i: number): boolean {
  if (i < d.numRequiredSignatures) return i < d.numRequiredSignatures - d.numReadonlySigned;
  return i < d.accountKeys.length - d.numReadonlyUnsigned;
}
