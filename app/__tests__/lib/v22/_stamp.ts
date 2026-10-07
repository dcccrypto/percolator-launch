import { LAYOUT_V21, LAYOUT_V22, type LayoutTable } from "@/lib/v22/sdk";

export const WRAPPER_MAGIC = 0x5045_5243_5631_3600n;

export function stampHeader(d: Uint8Array, kind: number, version: number): Uint8Array {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  v.setBigUint64(0, WRAPPER_MAGIC, true);
  v.setUint16(8, version, true);
  d[10] = kind;
  return d;
}

export function put128(d: Uint8Array, o: number, x: bigint): void {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  v.setBigUint64(o, x & ((1n << 64n) - 1n), true);
  v.setBigUint64(o + 8, x >> 64n, true);
}

/** A market buffer of `slots` asset slots for a layout row, with insurance and slot-1 long OI set. */
export function syntheticMarket(L: LayoutTable, slots: number, opts: { insurance?: bigint; oiLongSlot1?: bigint; version?: number } = {}): Uint8Array {
  const d = stampHeader(new Uint8Array(L.marketGroupOff + L.marketGroupLen + slots * L.assetSlotStride), 1, opts.version ?? L.version);
  put128(d, L.marketGroupOff + L.group.insurance, opts.insurance ?? 777n);
  if (slots > 1) put128(d, L.marketGroupOff + L.marketGroupLen + L.assetSlotStride + L.wrapperSlotLen + L.assetState.oiEffLongQ, opts.oiLongSlot1 ?? 5n);
  return d;
}

/** A portfolio buffer for a layout row with owner, one active leg in slot 0 (side/basis set). */
export function syntheticPortfolio(L: LayoutTable, opts: { capital?: bigint; version?: number; discriminator?: number } = {}): Uint8Array {
  const g = L.portfolio;
  const d = stampHeader(new Uint8Array(g.accountLen), 2, opts.version ?? L.version);
  const v = new DataView(d.buffer);
  v.setUint16(g.provenanceVersionOff, 1, true);
  v.setUint16(g.provenanceDiscriminatorOff, opts.discriminator ?? L.engineDiscriminator, true);
  put128(d, 16 + 132, opts.capital ?? 1234n); // capital
  const leg = g.legsOff;
  d[leg + g.leg.active] = 1;
  v.setUint32(leg + g.leg.assetIndex, 3, true);
  d[leg + g.leg.side] = 1;
  put128(d, leg + g.leg.basisPosQ, 42n);
  // epochSnap sits at a DIFFERENT offset per layout (86 on v2.1, 118 on v2.2 variant B)
  v.setBigUint64(leg + g.leg.epochSnap, 99n, true);
  return d;
}

export { LAYOUT_V21, LAYOUT_V22 };
