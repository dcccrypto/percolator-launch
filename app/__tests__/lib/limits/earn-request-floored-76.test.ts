// @vitest-environment node
/**
 * AUD-S1-18 (v2.2 audit 2026-10-17): the app's Earn request (tag 76) is ALWAYS the floored v2.2 wire
 * `[76, shares u128, min_payout u64, keeper_ok u8]`, never the floorless 17-byte legacy form, and the
 * floor comes from the vault's own quote (EARN_REQUEST_FLOOR_BPS under it). Byte layout pinned to
 * percolator-prog v16_program.rs tag-76 decode (deployed aca02ba6 and 4d69ee52 alike).
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  EARN_REQUEST_FLOOR_BPS,
  buildRequestRedeemIx,
  earnRequestFloorAtoms,
  earnRequestQuoteAtoms,
} from "@/lib/limits/earn-ixs";
import { earnExitProps } from "@/lib/limits/resolved-finish";

const pk = () => Keypair.generate().publicKey;
const le = (b: Uint8Array, off: number, n: number): bigint => {
  let v = 0n;
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!);
  return v;
};

function ix(shares: bigint, minPayoutAtoms: bigint) {
  return buildRequestRedeemIx({
    programId: pk(), redeemer: pk(), registry: pk(), lpMint: pk(), redeemerLpAta: pk(), escrow: pk(), redemption: pk(),
    shares, minPayoutAtoms,
  });
}

describe("AUD-S1-18: floored tag 76", () => {
  it("encodes 26 bytes: tag 76, shares u128, the floor u64, keeper_ok 0", () => {
    const shares = (1n << 100n) + 123_456_789n;
    const d = new Uint8Array(ix(shares, 987_654_321n).data);
    expect(d.length).toBe(26);
    expect(d[0]).toBe(76);
    expect(le(d, 1, 16)).toBe(shares);
    expect(le(d, 17, 8)).toBe(987_654_321n);
    expect(d[25]).toBe(0);
  });

  it("never emits the legacy 17-byte floorless form, and refuses a zero floor", () => {
    expect(new Uint8Array(ix(5n, 1n).data).length).not.toBe(17);
    expect(() => ix(5n, 0n)).toThrow(/non-zero payout floor/);
  });

  it("keeps the 8-account list (redeemer signs)", () => {
    const k = ix(5n, 1n).keys;
    expect(k).toHaveLength(8);
    expect(k[0]!.isSigner && k[0]!.isWritable).toBe(true);
  });

  it("floor = quote minus EARN_REQUEST_FLOOR_BPS, at least 1 atom; no quote => 1", () => {
    expect(EARN_REQUEST_FLOOR_BPS).toBe(1_000n);
    expect(earnRequestFloorAtoms(1_000_000n)).toBe(900_000n);
    expect(earnRequestFloorAtoms(1_000_000n, 5n)).toBe(999_500n);
    expect(earnRequestFloorAtoms(1n)).toBe(1n);
    expect(earnRequestFloorAtoms(0n)).toBe(1n);
    expect(earnRequestFloorAtoms(null)).toBe(1n);
    expect(earnRequestFloorAtoms(undefined)).toBe(1n);
    expect(() => earnRequestFloorAtoms(10n, 10_001n)).toThrow();
  });

  it("quote: two-pot at the combined NAV over registry shares; else backing NAV over supply; else null", () => {
    expect(earnRequestQuoteAtoms(250n, { splitPot: { navAtoms: 2_000n, totalShares: 1_000n }, backingNavAtoms: 9n, lpSupply: 9n })).toBe(500n);
    expect(earnRequestQuoteAtoms(250n, { splitPot: null, backingNavAtoms: 3_000n, lpSupply: 1_000n })).toBe(750n);
    expect(earnRequestQuoteAtoms(250n, { splitPot: null, backingNavAtoms: 3_000n, lpSupply: 0n })).toBeNull();
    expect(earnRequestQuoteAtoms(0n, { backingNavAtoms: 3_000n, lpSupply: 1_000n })).toBeNull();
  });

  it("earnExitProps hands the resolved finish batch a quote for exactly the requestable shares", () => {
    const base = { userLpBalance: 400n, userRedeemableValue: 0n, pendingRedemptionShares: 0n, splitPot: null, backingNavAtoms: 2_000n, lpSupply: 1_000n };
    const p = earnExitProps(base, 6, "USDC");
    expect(p.requestableShares).toBe(400n);
    expect(p.requestQuoteAtoms).toBe(800n);
    expect(earnExitProps({ ...base, pendingRedemptionShares: 5n }, 6, "USDC").requestQuoteAtoms).toBeNull();
    expect(earnExitProps({ ...base, userLpBalance: 0n }, 6, "USDC").requestQuoteAtoms).toBeNull();
  });
});
