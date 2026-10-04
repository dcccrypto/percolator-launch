// @vitest-environment node
/**
 * CloseSlab leaves a 16-byte wrapper-owned tombstone (wrapper 553d76f0, src/v16_program.rs
 * `handle_close_slab` ~19904-19938 + `state::write_closed_market_tombstone` ~3029), never a null
 * account. These tests build the bytes the way the Rust does and decode them with the app code.
 */
import { describe, expect, it, vi } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";

const { WRAPPER, OTHER_PROGRAM } = vi.hoisted(() => ({
  WRAPPER: "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB",
  OTHER_PROGRAM: "GnwdeQrAh4qzChJeVLrM21CXXWC1akjLH3DiijwzEEYZ",
}));

vi.mock("@/lib/config", () => ({ getConfig: () => ({ network: "devnet", programId: WRAPPER }) }));

import { buildClosedMarketTombstone, isClosedMarketTombstone } from "@/lib/closed-market-tombstone";
import { readLiveMarketStateResolutions, readSlabExistence } from "@/lib/live-market-state";

/**
 * Port of the Rust, byte for byte (percolator-prog 553d76f0):
 *   MAGIC = 0x5045_5243_5631_3600, VERSION = 18, HEADER_LEN = 16, KIND_CLOSED_MARKET = 8
 *   write_closed_market_tombstone: len must be HEADER_LEN; data.fill(0); write_header(data, 8)
 *   write_header: data[0..8] = MAGIC.to_le_bytes(); data[8..10] = VERSION.to_le_bytes(); data[10] = kind;
 *                 data[11..16] = 0
 */
function rustTombstone(): Uint8Array {
  const data = new Uint8Array(16);
  data.fill(0);
  let magic = 0x5045_5243_5631_3600n;
  for (let i = 0; i < 8; i++) {
    data[i] = Number(magic & 0xffn);
    magic >>= 8n;
  }
  data[8] = 18 & 0xff;
  data[9] = (18 >> 8) & 0xff;
  data[10] = 8;
  return data;
}

const SLAB_TOMB = Keypair.generate().publicKey.toBase58();
const SLAB_LIVE = Keypair.generate().publicKey.toBase58();
const SLAB_NULL = Keypair.generate().publicKey.toBase58();

const owner = (s: string) => new PublicKey(s);
const acct = (data: Uint8Array, ownerKey = WRAPPER) => ({ data: Buffer.from(data), owner: owner(ownerKey) });
const conn = (infos: unknown[]) =>
  ({ getMultipleAccountsInfo: vi.fn(async () => infos) }) as unknown as Connection & {
    getMultipleAccountsInfo: ReturnType<typeof vi.fn>;
  };

// A live market header is the SAME magic/version with kind 1, followed by a large body.
const liveHeaderSlice = (len: number) => {
  const d = new Uint8Array(len);
  d.set(rustTombstone().subarray(0, 16));
  d[10] = 1;
  return d;
};

describe("closed-market tombstone bytes", () => {
  it("app builder equals the Rust layout and the literal bytes", () => {
    expect(Array.from(buildClosedMarketTombstone())).toEqual(Array.from(rustTombstone()));
    expect(Buffer.from(rustTombstone()).toString("hex")).toBe("00363156435245501200080000000000");
  });

  it("decodes exactly the tombstone", () => {
    expect(isClosedMarketTombstone(rustTombstone())).toBe(true);
  });

  const mutate = (fn: (d: Uint8Array) => void) => {
    const d = rustTombstone();
    fn(d);
    return d;
  };
  it.each([
    ["kind 1 (a live market header)", mutate((d) => (d[10] = 1))],
    ["kind 7", mutate((d) => (d[10] = 7))],
    ["version 17", mutate((d) => (d[8] = 17))],
    ["magic byte flipped", mutate((d) => (d[0] ^= 1))],
    ["non-zero trailer byte", mutate((d) => (d[15] = 1))],
    ["15 bytes", rustTombstone().subarray(0, 15)],
    ["17 bytes (header + extra)", new Uint8Array([...rustTombstone(), 0])],
    ["empty", new Uint8Array(0)],
  ])("NEGATIVE CONTROL: %s is not a tombstone", (_n, bytes) => {
    expect(isClosedMarketTombstone(bytes)).toBe(false);
  });
  it("null/undefined are not tombstones", () => {
    expect(isClosedMarketTombstone(null)).toBe(false);
    expect(isClosedMarketTombstone(undefined)).toBe(false);
  });
});

describe("readSlabExistence: tombstone = confirmed dead", () => {
  it("POSITIVE CONTROL: wrapper-owned 16-byte tombstone (as a 17-byte slice returns it) is missing+tombstoned; null is missing; live is neither", async () => {
    const c = conn([acct(rustTombstone()), null, acct(liveHeaderSlice(17))]);
    const r = await readSlabExistence([SLAB_TOMB, SLAB_NULL, SLAB_LIVE], c);
    expect([...r.missing].sort()).toEqual([SLAB_TOMB, SLAB_NULL].sort());
    expect([...r.tombstoned]).toEqual([SLAB_TOMB]);
    expect(r.unresolved.size).toBe(0);
    expect((c.getMultipleAccountsInfo.mock.calls[0] as unknown[])[1]).toEqual({ dataSlice: { offset: 0, length: 17 } });
  });

  it("NEGATIVE CONTROL: tombstone bytes owned by another program are NOT hidden", async () => {
    const r = await readSlabExistence([SLAB_TOMB, SLAB_LIVE], conn([acct(rustTombstone(), OTHER_PROGRAM), acct(liveHeaderSlice(17))]));
    expect(r.missing.size).toBe(0);
    expect(r.tombstoned.size).toBe(0);
  });

  it("NEGATIVE CONTROL: a live market's 17-byte header slice (kind 1) is NOT hidden", async () => {
    const r = await readSlabExistence([SLAB_LIVE], conn([acct(liveHeaderSlice(17))]));
    expect(r.missing.size).toBe(0);
  });

  it("NEGATIVE CONTROL: a 16-byte kind-1 account (len==16 alone is not enough) is NOT hidden", async () => {
    const r = await readSlabExistence([SLAB_LIVE, SLAB_TOMB], conn([acct(liveHeaderSlice(16)), acct(rustTombstone())]));
    expect([...r.missing]).toEqual([SLAB_TOMB]);
  });

  it("NEGATIVE CONTROL: an RPC error hides nothing (tombstone or not)", async () => {
    const c = { getMultipleAccountsInfo: vi.fn(async () => { throw new Error("rpc down"); }) } as unknown as Connection;
    const r = await readSlabExistence([SLAB_TOMB, SLAB_LIVE], c);
    expect(r.missing.size).toBe(0);
    expect(r.unresolved.size).toBe(2);
  });

  it("NEGATIVE CONTROL: a missing owner field is unknown, not dead", async () => {
    const r = await readSlabExistence([SLAB_TOMB], conn([{ data: Buffer.from(rustTombstone()) }]));
    expect(r.missing.size).toBe(0);
  });

  it("wrong-cluster guard still holds: an all-null reply hides nothing; a tombstone proves our cluster so a sibling null IS missing", async () => {
    const allNull = await readSlabExistence([SLAB_TOMB, SLAB_NULL], conn([null, null]));
    expect(allNull.missing.size).toBe(0);
    const mixed = await readSlabExistence([SLAB_TOMB, SLAB_NULL], conn([acct(rustTombstone()), null]));
    expect([...mixed.missing].sort()).toEqual([SLAB_TOMB, SLAB_NULL].sort());
  });
});

describe("readLiveMarketStateResolutions: tombstone = confirmed dead, never a zeroed state", () => {
  it("POSITIVE CONTROL: the full-read path classifies the tombstone as missing and yields no state", async () => {
    const r = await readLiveMarketStateResolutions([SLAB_TOMB], conn([acct(rustTombstone())]));
    expect(r.missing.has(SLAB_TOMB)).toBe(true);
    expect(r.tombstoned.has(SLAB_TOMB)).toBe(true);
    expect(r.states.has(SLAB_TOMB)).toBe(false);
  });

  it("NEGATIVE CONTROL: another program's tombstone-shaped account is not classified dead", async () => {
    const r = await readLiveMarketStateResolutions([SLAB_TOMB], conn([acct(rustTombstone(), OTHER_PROGRAM)]));
    expect(r.missing.has(SLAB_TOMB)).toBe(false);
    expect(r.tombstoned.size).toBe(0);
  });
});
