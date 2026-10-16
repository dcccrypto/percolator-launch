/**
 * Offsets inside a MARKET account, resolved from its VERSION, for the legacy readers that address fields by the v2.1 constants
 * (lib/limits/constants.ts, lib/self-heal.ts). The v2.2 layout differs from v2.1 in exactly three ways, all derived from the
 * SDK table (never a second copy of the numbers):
 *   - the group header is longer: every header field AFTER the 249-byte config shifts by `hd = group.currentSlot - 613` (48);
 *     the config itself (rel 32..) and its internal fields do not move;
 *   - the asset-slot stride and the group length differ (`assetSlotStride`, `marketGroupLen`);
 *   - inside an engine slot every field AFTER `AssetStateV16Account` (v2.1 length 515) shifts by `sd = assetStateLen - 515` (112);
 *     the asset-state fields themselves (< 515) and the wrapper-slot prefix (records at +512, +608, +672, +896) do not move.
 * Flag off: the v21 table, `hd = sd = 0`, `g = 592`: byte-identical to the constants these readers always used.
 */
import { isDevnetV22Enabled } from "./flag";
import { ACCOUNT_KIND, LAYOUT_V21, resolveLayout, type LayoutTable } from "./sdk";

const V21_CURRENT_SLOT = 613;
const V21_ASSET_STATE_LEN = 515;
const V21_CONFIG_END = 32;

export interface MarketOffsets {
  layout: LayoutTable;
  /** Absolute offset of the market-group header. */
  g: number;
  /** Absolute offset of a v2.1-relative header field (shifted when it follows the config). */
  hdr(relV21: number): number;
  /** Absolute offset of asset `i`'s wrapper slot / engine slot. */
  wrapperOff(i: number): number;
  engineOff(i: number): number;
  /** Offset inside an engine slot of a v2.1-relative field (shifted when it follows the asset state). */
  slotRel(relV21: number): number;
  /** `marketGroupOff + marketGroupLen + stride` : bytes needed for asset 0. */
  sliceLen(i?: number): number;
}

function build(L: LayoutTable): MarketOffsets {
  const hd = L.group.currentSlot - V21_CURRENT_SLOT;
  const sd = L.assetStateLen - V21_ASSET_STATE_LEN;
  const slots = L.marketGroupOff + L.marketGroupLen;
  return {
    layout: L,
    g: L.marketGroupOff,
    hdr: (rel) => L.marketGroupOff + (rel > V21_CONFIG_END + 249 - 1 ? rel + hd : rel),
    wrapperOff: (i) => slots + i * L.assetSlotStride,
    engineOff: (i) => slots + i * L.assetSlotStride + L.wrapperSlotLen,
    slotRel: (rel) => (rel >= V21_ASSET_STATE_LEN ? rel + sd : rel),
    sliceLen: (i = 0) => slots + i * L.assetSlotStride + L.assetSlotStride,
  };
}

const V21 = build(LAYOUT_V21);

/**
 * Offsets for this market account. Flag off: the v2.1 constants, no checks (as before). Flag on: by the account's VERSION;
 * throws the SDK's typed `UnknownLayoutError` for an unknown VERSION / magic / non-market kind.
 */
export function marketOffsets(data: Uint8Array, parser = "marketOffsets"): MarketOffsets {
  if (!isDevnetV22Enabled()) return V21;
  return build(resolveLayout(data, { parser, kind: ACCOUNT_KIND.Market }));
}

/** Same, but null instead of throwing (for the readers that return null on anything they cannot read). */
export function marketOffsetsOrNull(data: Uint8Array, parser = "marketOffsets"): MarketOffsets | null {
  try {
    return marketOffsets(data, parser);
  } catch {
    return null;
  }
}
