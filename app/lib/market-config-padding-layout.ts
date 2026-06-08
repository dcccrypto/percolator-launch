/**
 * GH#2097 / PERC-8452: MarketConfig padding layout contract.
 *
 * Oracle Phase (PERC-622) and VRAM state must never share byte ranges inside
 * `_insurance_isolation_padding`. The collision described in GH#2097 is dormant
 * today because VRAM persistence is not enabled, but packing both subsystems into
 * bytes [4..14] would corrupt cumulative volume and phase-2 transition metadata.
 *
 * Implementers in percolator-prog should use typed fields (see PERC-622 design doc)
 * or the disjoint byte map below — never the overlapping packed layout.
 */

/** Inclusive byte range within a padding blob. */
export type ByteRange = { start: number; end: number; label: string };

/** Returns true when two inclusive ranges share at least one byte. */
export function byteRangesOverlap(a: ByteRange, b: ByteRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** True when no pair in `ranges` overlaps. */
export function assertDisjointRanges(ranges: ByteRange[]): boolean {
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (byteRangesOverlap(ranges[i], ranges[j])) return false;
    }
  }
  return true;
}

/**
 * Documented collision from GH#2097 — Oracle Phase vs VRAM packed into the same
 * `_insurance_isolation_padding[4..14]` window. These ranges overlap by design
 * (the bug). Kept as regression documentation; must stay overlapping so CI
 * catches accidental "fixes" that erase the reproducer.
 */
export const GH2097_COLLIDING_PACKED_LAYOUT: ByteRange[] = [
  { start: 3, end: 10, label: "cumul_vol" },
  { start: 4, end: 7, label: "ewmv" },
  { start: 8, end: 11, label: "last_vol_price" },
  { start: 11, end: 13, label: "phase2_delta" },
  { start: 12, end: 13, label: "vol_margin_scale" },
];

/**
 * Recommended disjoint layout inside a 42-byte expanded isolation padding block.
 * Oracle Phase occupies bytes 0..27; VRAM occupies bytes 28..41.
 */
export const GH2097_DISJOINT_PADDING_LAYOUT: ByteRange[] = [
  { start: 0, end: 0, label: "oracle_phase" },
  { start: 1, end: 7, label: "oracle_phase_reserved" },
  { start: 8, end: 15, label: "cumulative_volume_usd_e6" },
  { start: 16, end: 19, label: "phase2_delta_slots" },
  { start: 20, end: 27, label: "market_created_slot" },
  { start: 28, end: 31, label: "vram_reserved" },
  { start: 32, end: 35, label: "ewmv_e6" },
  { start: 36, end: 39, label: "last_vol_price_e6" },
  { start: 40, end: 41, label: "vol_margin_scale_bps" },
];

/** Oracle-only sub-ranges from the disjoint map (bytes 0..27). */
export const GH2097_ORACLE_PHASE_RANGES: ByteRange[] =
  GH2097_DISJOINT_PADDING_LAYOUT.filter((r) =>
    ["oracle_phase", "oracle_phase_reserved", "cumulative_volume_usd_e6", "phase2_delta_slots", "market_created_slot"].includes(
      r.label,
    ),
  );

/** VRAM-only sub-ranges from the disjoint map (bytes 28..41). */
export const GH2097_VRAM_RANGES: ByteRange[] = GH2097_DISJOINT_PADDING_LAYOUT.filter((r) =>
  ["vram_reserved", "ewmv_e6", "last_vol_price_e6", "vol_margin_scale_bps"].includes(r.label),
);
