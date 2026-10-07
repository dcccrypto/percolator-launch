/**
 * Review F4: the asset readers in lib/v18-wire.ts take the market BYTES and pick the slot offset by VERSION. The old
 * byte-less assetProfileOff threw with the flag on, which made admin / claim / close-market / update-authority readers fail.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { LAYOUT_V21, LAYOUT_V22, type LayoutTable } from "@/lib/v22/sdk";
import { assetProfileOff, readAssetAdmin, readAssetControlSeqs, readProtocolFeeAuthorityEpoch } from "@/lib/v18-wire";
import { syntheticMarket } from "./_stamp";

afterEach(() => __setDevnetV22ForTest(null));
const admin = Keypair.generate().publicKey;

/** A 2-slot market with distinctive values at ONE layout's offsets (asset 1 so the stride matters). */
function build(L: LayoutTable): Uint8Array {
  const d = syntheticMarket(L, 2);
  const slot1 = L.marketGroupOff + L.marketGroupLen + L.assetSlotStride;
  d.set(admin.toBytes(), slot1 + 368);
  new DataView(d.buffer).setBigUint64(slot1 + 512, 4242n, true); // oracle observation (control sequences @ +512)
  return d;
}

describe("flag on, v2.2 market", () => {
  it("readAssetAdmin / readAssetControlSeqs read asset 1 at the v2.2 stride", () => {
    __setDevnetV22ForTest(true);
    const d = build(LAYOUT_V22);
    expect(readAssetAdmin(d, 1).toBase58()).toBe(admin.toBase58());
    expect(readAssetControlSeqs(d, 1).oracleObservation).toBe(4242n);
    expect(assetProfileOff(1, d)).toBe(592 + 806 + 2629);
    expect(() => readProtocolFeeAuthorityEpoch(d)).not.toThrow();
  });
  it("NEGATIVE CONTROL: the v2.1 stride would read the wrong bytes", () => {
    __setDevnetV22ForTest(true);
    const d = build(LAYOUT_V22);
    const wrong = 592 + 758 + 2325 + 368;
    expect(new Uint8Array(d.subarray(wrong, wrong + 32))).not.toEqual(admin.toBytes());
  });
  it("the byte-less call no longer exists (compile-time) and a truncated buffer is refused, not guessed", () => {
    __setDevnetV22ForTest(true);
    // @ts-expect-error assetProfileOff requires the market bytes
    expect(() => assetProfileOff(0)).toThrow();
    expect(() => readAssetAdmin(new Uint8Array(100), 0)).toThrow();
  });
});

describe("flag off, v2.1 market: unchanged", () => {
  it("same readers at the v2.1 stride", () => {
    const d = build(LAYOUT_V21);
    expect(readAssetAdmin(d, 1).toBase58()).toBe(admin.toBase58());
    expect(readAssetControlSeqs(d, 1).oracleObservation).toBe(4242n);
    expect(assetProfileOff(1, d)).toBe(592 + 758 + 2325);
  });
});
