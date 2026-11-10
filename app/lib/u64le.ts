/**
 * Browser-safe little-endian u64 read.
 *
 * The browser Buffer polyfill bundled into the client has no BigInt read methods
 * (`readBigUInt64LE` is undefined there), so any client code path that called it threw
 * "readBigUInt64LE is not a function" before a transaction was ever built — that broke
 * every first trade on the live playground. The quiet-ledger rule applies: offsets are
 * absolute from the view start, never from a prior read. DataView works on any Uint8Array/Buffer.
 */
export function readU64LE(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}
