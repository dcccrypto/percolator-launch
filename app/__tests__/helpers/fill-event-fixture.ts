import { PublicKey } from "@solana/web3.js";

/** Builds the logMessages of a wrapper tx carrying one FILL event (layout: v22-fill-events.ts; 100-byte header + 75-byte records). */
export function fillEventLogs(wrapper: PublicKey, market: PublicKey, recs: Array<{ flags: number; requestedQ: bigint; executedQ: bigint; assetIndex?: number }>): string[] {
  const b = Buffer.alloc(100 + 75 * recs.length);
  b[0] = 1; b[1] = 1; b[2] = 10;
  market.toBuffer().copy(b, 3);
  new PublicKey("11111111111111111111111111111111").toBuffer().copy(b, 35);
  new PublicKey("11111111111111111111111111111111").toBuffer().copy(b, 67);
  b[99] = recs.length;
  recs.forEach((r, i) => {
    const o = 100 + 75 * i;
    b.writeUInt16LE(r.assetIndex ?? 0, o);
    b[o + 10] = r.flags;
    const i128 = (v: bigint, off: number) => { b.writeBigUInt64LE(v & 0xffffffffffffffffn, off); b.writeBigInt64LE(v >> 64n, off + 8); };
    i128(r.requestedQ, o + 11);
    i128(r.executedQ, o + 27);
    b.writeBigUInt64LE(100_000_000n, o + 43);
  });
  const w = wrapper.toBase58();
  return [`Program ${w} invoke [1]`, `Program data: ${b.toString("base64")}`, `Program ${w} success`];
}
