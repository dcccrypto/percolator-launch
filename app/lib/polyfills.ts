/**
 * Browser polyfills for @solana/web3.js dependencies.
 * Import this at the top of the root layout to ensure BN and Buffer
 * are available globally before any Solana code runs.
 *
 * Fixes:
 * - "can't access property BN, t is undefined" on some browsers.
 * - "writeBigUInt64LE is not a function" thrown by spl-token's
 *   createExecuteInstruction on transfer-hook paths, when the browser's
 *   polyfilled Buffer predates Node 12's BigInt read/write methods.
 */

import { Buffer } from "buffer";

if (typeof window !== "undefined") {
  // Buffer polyfill
  if (!window.Buffer) {
    (window as unknown as Record<string, unknown>).Buffer = Buffer;
  }
}

// BigInt JSON serialization — prevents "Do not know how to serialize BigInt" crashes
// Safe: only adds toJSON if not already defined
if (typeof BigInt !== "undefined" && !(BigInt.prototype as unknown as Record<string, unknown>).toJSON) {
  (BigInt.prototype as unknown as Record<string, unknown>).toJSON = function () {
    return this.toString();
  };
}

// Buffer BigInt read/write methods (Node 12+). Some browser bundlers
// ship an older buffer polyfill that lacks these. @solana/spl-token's
// createExecuteInstruction calls `data.writeBigUInt64LE(BigInt(amount), 8)`
// when building the TransferHook Execute ix, which crashes the whole
// Send NFT flow with "c.writeBigUInt64LE is not a function". Install the
// methods on both the imported Buffer's prototype and (if it differs)
// the global Buffer's prototype so whatever the spl-token chunk bundled
// gets the patch.
type BigIntCapableBuffer = Buffer & {
  writeBigUInt64LE: (value: bigint, offset?: number) => number;
  writeBigInt64LE: (value: bigint, offset?: number) => number;
  readBigUInt64LE: (offset?: number) => bigint;
  readBigInt64LE: (offset?: number) => bigint;
};

function installBigIntBufferShim(
  target: typeof Buffer | undefined,
): void {
  if (!target) return;
  const proto = target.prototype as Partial<BigIntCapableBuffer>;
  if (typeof proto.writeBigUInt64LE !== "function") {
    proto.writeBigUInt64LE = function (
      this: Buffer,
      value: bigint,
      offset = 0,
    ): number {
      const lo = Number(value & 0xffffffffn);
      const hi = Number((value >> 32n) & 0xffffffffn);
      this.writeUInt32LE(lo, offset);
      this.writeUInt32LE(hi, offset + 4);
      return offset + 8;
    };
  }
  if (typeof proto.writeBigInt64LE !== "function") {
    proto.writeBigInt64LE = function (
      this: Buffer,
      value: bigint,
      offset = 0,
    ): number {
      // Two's-complement encode into an unsigned 64-bit value, then write.
      const u = BigInt.asUintN(64, value);
      return (this as BigIntCapableBuffer).writeBigUInt64LE(u, offset);
    };
  }
  if (typeof proto.readBigUInt64LE !== "function") {
    proto.readBigUInt64LE = function (this: Buffer, offset = 0): bigint {
      const lo = BigInt(this.readUInt32LE(offset));
      const hi = BigInt(this.readUInt32LE(offset + 4));
      return (hi << 32n) | lo;
    };
  }
  if (typeof proto.readBigInt64LE !== "function") {
    proto.readBigInt64LE = function (this: Buffer, offset = 0): bigint {
      const u = (this as BigIntCapableBuffer).readBigUInt64LE(offset);
      // Interpret as signed two's-complement.
      return BigInt.asIntN(64, u);
    };
  }
}

installBigIntBufferShim(Buffer);
if (typeof window !== "undefined") {
  const globalBuffer = (window as unknown as { Buffer?: typeof Buffer })
    .Buffer;
  if (globalBuffer && globalBuffer !== Buffer) {
    installBigIntBufferShim(globalBuffer);
  }
}

export {};
