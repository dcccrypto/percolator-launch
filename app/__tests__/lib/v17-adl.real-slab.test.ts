/**
 * Layout pinned against a REAL captured account, not a hand-built buffer whose
 * offsets the test itself wrote (which is how a wrong "273" comment survived).
 * Fixture: devnet v18 TRUMP market CdN8r7FB... with open interest, captured 2026-10-04.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { parseAssetAdlFactors, ADL_ONE } from "@/lib/v17-adl";
import { V17_MARKET_GROUP_OFF, V17_MARKET_GROUP_LEN, V17_ASSET_SLOT_WRAPPER_LEN } from "@percolatorct/sdk";

const fx = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../fixtures/trump-v18-slab.json"), "utf8")) as { dataBase64: string };
const slab = new Uint8Array(Buffer.from(fx.dataBase64, "base64"));
const dv = new DataView(slab.buffer, slab.byteOffset, slab.byteLength);
const BASE = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN + V17_ASSET_SLOT_WRAPPER_LEN;
const u64 = (rel: number) => dv.getBigUint64(BASE + rel, true);
const u128 = (rel: number) => u64(rel) | (dv.getBigUint64(BASE + rel + 8, true) << 64n);

describe("asset-state layout against a real slab", () => {
  it("a_long / a_short parse to ADL_ONE (never deleveraged)", () => {
    const f = parseAssetAdlFactors(slab, 0)!;
    expect(f.aLong).toBe(ADL_ONE);
    expect(f.aShort).toBe(ADL_ONE);
    expect(f.epochLong).toBe(0n);
    expect(f.modeLong).toBe(0);
  });

  it("oi_eff_long_q is at rel 289 (49 + 15*16), balanced with oi_eff_short_q and the loss-weight sums", () => {
    const oi = u128(289);
    expect(oi).toBeGreaterThan(0n);
    expect(u128(305)).toBe(oi); // oi_eff_short_q
    expect(u128(369)).toBe(oi); // loss_weight_sum_long (balanced book)
    expect(u128(385)).toBe(oi); // loss_weight_sum_short
    expect([u64(321), u64(329)]).toEqual([1n, 1n]); // stored_pos_count long/short: one leg each
  });

  it("NEGATIVE CONTROL: the stale 273 reads zero, not the open interest", () => {
    expect(u128(273)).toBe(0n);
    expect(u128(273)).not.toBe(u128(289));
  });
});
