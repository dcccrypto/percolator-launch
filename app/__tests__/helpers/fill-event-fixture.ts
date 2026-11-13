import { PublicKey } from "@solana/web3.js";

/** Builds the logMessages of a wrapper tx carrying one FILL event (layout: v22-fill-events.ts; 100-byte header + 75-byte records). */
export function fillEventLogs(wrapper: PublicKey, market: PublicKey, recs: Array<{ flags: number; requestedQ: bigint; executedQ: bigint; assetIndex?: number; priceE6?: bigint; quotedPriceE6?: bigint; feeAtoms?: bigint }>, taker?: PublicKey): string[] {
  const b = Buffer.alloc(100 + 75 * recs.length);
  b[0] = 1; b[1] = 1; b[2] = 10;
  market.toBuffer().copy(b, 3);
  (taker ?? new PublicKey("11111111111111111111111111111111")).toBuffer().copy(b, 35);
  new PublicKey("11111111111111111111111111111111").toBuffer().copy(b, 67);
  b[99] = recs.length;
  recs.forEach((r, i) => {
    const o = 100 + 75 * i;
    b.writeUInt16LE(r.assetIndex ?? 0, o);
    b[o + 10] = r.flags;
    const i128 = (v: bigint, off: number) => { b.writeBigUInt64LE(v & 0xffffffffffffffffn, off); b.writeBigInt64LE(v >> 64n, off + 8); };
    i128(r.requestedQ, o + 11);
    i128(r.executedQ, o + 27);
    b.writeBigUInt64LE(r.priceE6 ?? 100_000_000n, o + 43);
    b.writeBigUInt64LE(r.quotedPriceE6 ?? 0n, o + 51);
    b.writeBigUInt64LE(r.feeAtoms ?? 0n, o + 59);
  });
  const w = wrapper.toBase58();
  return [`Program ${w} invoke [1]`, `Program data: ${b.toString("base64")}`, `Program ${w} success`];
}

/** Builds the logMessages of a wrapper tx carrying one REDUCE event (134 bytes) for `portfolio`. */
export function reduceEventLogs(wrapper: PublicKey, market: PublicKey, portfolio: PublicKey, o: { reason: number; signedReducedQ: bigint; assetIndex?: number; priceE6?: bigint }): string[] {
  const b = Buffer.alloc(134);
  b[0] = 2; b[1] = 1; b[2] = 10;
  market.toBuffer().copy(b, 3);
  portfolio.toBuffer().copy(b, 35);
  b.writeUInt16LE(o.assetIndex ?? 0, 99);
  b[109] = o.reason;
  const v = o.signedReducedQ;
  b.writeBigUInt64LE(v & 0xffffffffffffffffn, 110);
  b.writeBigInt64LE(v >> 64n, 118);
  b.writeBigUInt64LE(o.priceE6 ?? 100_000_000n, 126);
  const w = wrapper.toBase58();
  return [`Program ${w} invoke [1]`, `Program data: ${b.toString("base64")}`, `Program ${w} success`];
}
