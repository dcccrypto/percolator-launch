/**
 * CloseSlab does NOT delete a market slab (wrapper 553d76f0, `handle_close_slab`,
 * src/v16_program.rs ~19904-19938). It `realloc`s the account to `HEADER_LEN` (16 bytes), calls
 * `state::write_closed_market_tombstone`, keeps `CLOSED_MARKET_TOMBSTONE_RENT_LAMPORTS` and leaves
 * the account owned by the wrapper ("never draining to 0": the address can never be reused). So a
 * closed market is NOT a `null` account; it is this exact 16-byte tombstone:
 *
 *   write_closed_market_tombstone: require len == HEADER_LEN, data.fill(0), then write_header(KIND_CLOSED_MARKET):
 *     [0..8)   MAGIC   u64 LE = 0x5045_5243_5631_3600 ("PERCV16\0")
 *     [8..10)  VERSION u16 LE = 18
 *     [10]     kind    u8     = KIND_CLOSED_MARKET = 8
 *     [11..16) zero
 *
 * Decoding is exact on purpose. A live market starts with the same magic/version but kind 1 and is
 * ~25KB, so "len == 16" alone is not the tombstone (a sliced read of a live market is also short).
 */
import { HEADER_LEN, WRAPPER_MAGIC, WRAPPER_VERSION_V18 } from "@/lib/limits/constants";
import { KIND_CLOSED_MARKET } from "@/lib/limits/close-slab";

const KIND_OFF = 10;

/** The exact bytes `write_closed_market_tombstone` leaves in the account. */
export function buildClosedMarketTombstone(): Uint8Array {
  const out = new Uint8Array(HEADER_LEN); // data.fill(0)
  const view = new DataView(out.buffer);
  view.setBigUint64(0, WRAPPER_MAGIC, true);
  view.setUint16(8, WRAPPER_VERSION_V18, true);
  out[KIND_OFF] = KIND_CLOSED_MARKET;
  return out;
}

/**
 * True only for the exact tombstone: the account is EXACTLY 16 bytes, magic and version match,
 * kind is 8 and the 5 trailing header bytes are zero. `data` must be the whole account (or a
 * dataSlice that proves the length, i.e. a slice longer than 16 that came back with 16 bytes).
 */
export function isClosedMarketTombstone(data: Uint8Array | null | undefined): boolean {
  if (!data || data.length !== HEADER_LEN) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getBigUint64(0, true) !== WRAPPER_MAGIC) return false;
  if (view.getUint16(8, true) !== WRAPPER_VERSION_V18) return false;
  if (data[KIND_OFF] !== KIND_CLOSED_MARKET) return false;
  for (let i = KIND_OFF + 1; i < HEADER_LEN; i++) if (data[i] !== 0) return false;
  return true;
}

/** Length requested by the existence probe: one byte past the header proves "exactly 16 bytes". */
export const TOMBSTONE_PROBE_SLICE_LEN = HEADER_LEN + 1;
