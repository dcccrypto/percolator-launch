/**
 * Creator fee claim — read-path tests (lib/v17-creator-fee.ts).
 *
 * The value under test is a number a UI will render next to a "Claim" button, so
 * the failure mode that matters is a SILENT misread: an off-by-8 offset, the
 * wrong u64 in the config tail, a u128 widening that swallows the market-group
 * header, or a Number() narrowing that quietly rounds. Every assertion below is
 * built to fail on one of those specifically:
 *
 *  - the synthetic account poisons EVERY 8-byte neighbour of 584 with a distinct
 *    sentinel, so any offset slip returns a recognisably wrong value rather than
 *    a plausible one;
 *  - the target value is > 2^53, so a Number() round-trip loses precision;
 *  - the real devnet fixture (a pre-upgrade market whose 584..592 is genuinely
 *    zero) has NON-ZERO bytes on both sides, so "reads 0n" pins the offset
 *    instead of being satisfied by any mistake that happens to land on a zero;
 *  - the claim authority is asserted to be `insurance_operator` and explicitly
 *    NOT `marketauth` — the divergence that keeps a staked market claimable by
 *    its creator rather than by the stake-pool PDA.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  v17MarketAccountLen,
  V17_CREATOR_FEE_CLAIMABLE_OFF,
  V17_HEADER_LEN,
  V17_KIND_MARKET,
  V17_KIND_OFF,
  V17_MARKET_GROUP_LEN,
  V17_MARKET_GROUP_OFF,
  V17_WRAPPER_CONFIG_LEN,
} from "@percolatorct/sdk";
import {
  readCreatorFeeClaimable,
  isCreatorFeeClaimAuthority,
  V17_CREATOR_FEE_CLAIMABLE_ABS_OFF,
  V17_CREATOR_FEE_CLAIMABLE_IS_CONFIG_TAIL,
} from "@/lib/v17-creator-fee";
import { V17_ENGINE_CONFIG_OFF } from "@/lib/v17-engine-config";
import { formatTokenAmount } from "@/lib/format";

// ── Synthetic v17 market account ───────────────────────────────────────────────
// Absolute offsets: header 0..16, WrapperConfigV16 16..592, market group
// 592..1350, asset slot 0 (profile first) 1350..3147.
const CFG = V17_HEADER_LEN; // 16
const PROFILE_OFF = V17_MARKET_GROUP_OFF + V17_MARKET_GROUP_LEN; // 1350
const PROFILE_INSURANCE_OPERATOR_REL = 56;

/** > 2^53: a Number() round-trip of this loses the low bits. */
const CLAIMABLE = 9_007_199_254_740_993n; // 2^53 + 1
const MARKETAUTH = new PublicKey("HLyBte5HgLjZRAfhXRXgzRFc4BXTqPVwadBHEUxY6ftD");
const OPERATOR = new PublicKey("FeDAMgMCs4RHoSmZg9egBKfQFyf4eZb98PLAqK88c2Ah");
const MINT = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");

function makeV17Market(claimable: bigint, kind: number = V17_KIND_MARKET): Uint8Array {
  const buf = Buffer.alloc(v17MarketAccountLen(1)); // 3147
  // header: magic "PERCV16\0" LE, version 17, kind
  buf.set([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50], 0);
  buf.writeUInt16LE(17, 8);
  buf[V17_KIND_OFF] = kind;

  // config fields we read
  buf.set(MARKETAUTH.toBytes(), CFG + 0);
  buf.set(MINT.toBytes(), CFG + 32);

  // ── Poison every neighbour so an offset slip is detectable ──────────────
  // insurance_reserve_withdrawn_atoms (u128 @544) — the field immediately
  // before the shares; a -24 slip lands here.
  buf.fill(0xa5, CFG + 544, CFG + 560);
  // the three u16 shares @560/562/564
  buf.writeUInt16LE(1600, CFG + 560);
  buf.writeUInt16LE(4800, CFG + 562);
  buf.writeUInt16LE(1600, CFG + 564);
  // _padding_split [u8;2] @566 — a -8 read starts here and drags in the shares.
  buf.fill(0xee, CFG + 566, CFG + 568);
  // the counter itself @568 (absolute 584)
  buf.writeBigUInt64LE(claimable, CFG + V17_CREATOR_FEE_CLAIMABLE_OFF);
  // start of the market-group region @592 — a +8 read, or a u128 widening of
  // the counter, drags these bytes in.
  buf.fill(0xc3, V17_MARKET_GROUP_OFF, V17_MARKET_GROUP_OFF + 8);

  // asset 0 profile: insurance_operator (the claim authority)
  buf.set(OPERATOR.toBytes(), PROFILE_OFF + PROFILE_INSURANCE_OPERATOR_REL);
  return new Uint8Array(buf);
}

// ── Real devnet market, captured pre-upgrade (584..592 still zeroed padding) ──
const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "BPgSUbDs.market.json"), "utf-8"),
) as { market: string; owner: string; dataLen: number; dataBase64: string };
const fixtureData = new Uint8Array(Buffer.from(fixture.dataBase64, "base64"));

describe("layout — the field is additive IN PLACE (nothing downstream moved)", () => {
  it("sits at config-relative 568 / absolute 584", () => {
    expect(V17_CREATOR_FEE_CLAIMABLE_OFF).toBe(568);
    expect(V17_CREATOR_FEE_CLAIMABLE_ABS_OFF).toBe(584);
    expect(V17_CREATOR_FEE_CLAIMABLE_ABS_OFF).toBe(
      V17_HEADER_LEN + V17_CREATOR_FEE_CLAIMABLE_OFF,
    );
  });

  it("occupies the config's final 8 bytes — config length is STILL 576", () => {
    expect(V17_WRAPPER_CONFIG_LEN).toBe(576);
    expect(V17_CREATOR_FEE_CLAIMABLE_OFF + 8).toBe(V17_WRAPPER_CONFIG_LEN);
    expect(V17_CREATOR_FEE_CLAIMABLE_IS_CONFIG_TAIL).toBe(true);
  });

  it("leaves every downstream offset unmoved (no migration needed)", () => {
    expect(V17_MARKET_GROUP_OFF).toBe(592);
    expect(V17_MARKET_GROUP_LEN).toBe(758);
    expect(V17_ENGINE_CONFIG_OFF).toBe(624); // engine config, 592 + 32
    expect(PROFILE_OFF).toBe(1350); // asset profiles
  });
});

describe("readCreatorFeeClaimable — synthetic account with poisoned neighbours", () => {
  const data = makeV17Market(CLAIMABLE);

  it("reads exactly the u64 at 584, not any adjacent field", () => {
    const claim = readCreatorFeeClaimable(data);
    expect(claim).not.toBeNull();
    expect(claim!.atoms).toBe(CLAIMABLE);
  });

  it("does not widen past 8 bytes into the market-group region", () => {
    // A u128 read at 584 would absorb the 0xc3 fill at 592 and return
    // CLAIMABLE + 0xc3c3c3c3c3c3c3c3 << 64.
    const claim = readCreatorFeeClaimable(data)!;
    expect(claim.atoms).toBeLessThan(1n << 64n);
    expect(claim.atoms).toBe(CLAIMABLE);
  });

  it("keeps full precision above 2^53 (bigint, never Number)", () => {
    const claim = readCreatorFeeClaimable(data)!;
    expect(typeof claim.atoms).toBe("bigint");
    expect(claim.atoms).toBe(9_007_199_254_740_993n);
    // The lossy path: Number(2^53 + 1) === 2^53. Prove we are not on it.
    expect(claim.atoms).not.toBe(BigInt(Number(claim.atoms) - 1));
    expect(BigInt(Number(CLAIMABLE))).not.toBe(CLAIMABLE); // the trap is real
  });

  it("reads max u64 without overflow or clamping", () => {
    const max = (1n << 64n) - 1n;
    const claim = readCreatorFeeClaimable(makeV17Market(max))!;
    expect(claim.atoms).toBe(18_446_744_073_709_551_615n);
  });

  it("reads 0n on a market that has accrued nothing", () => {
    const claim = readCreatorFeeClaimable(makeV17Market(0n))!;
    expect(claim.atoms).toBe(0n);
  });

  it("reports the collateral mint the payout is denominated in", () => {
    const claim = readCreatorFeeClaimable(data)!;
    expect(claim.collateralMint.toBase58()).toBe(MINT.toBase58());
  });

  it("reports insurance_operator as the claim authority, NOT marketauth", () => {
    const claim = readCreatorFeeClaimable(data)!;
    expect(claim.claimAuthority).not.toBeNull();
    expect(claim.claimAuthority!.toBase58()).toBe(OPERATOR.toBase58());
    // marketauth is a DIFFERENT key here on purpose: StakeInitPool rotates
    // marketauth to the pool PDA but never insurance_operator, so reading
    // marketauth would show the wrong claimant on a staked market.
    expect(claim.claimAuthority!.toBase58()).not.toBe(MARKETAUTH.toBase58());
  });

  it("formats to an exact decimal string for display (no float rounding)", () => {
    const claim = readCreatorFeeClaimable(data)!;
    expect(formatTokenAmount(claim.atoms, 6)).toBe("9007199254.740993");
  });
});

describe("readCreatorFeeClaimable — real devnet market (pre-upgrade padding)", () => {
  it("the fixture's neighbours are non-zero, so a 0n read pins the offset", () => {
    const dv = new DataView(
      fixtureData.buffer,
      fixtureData.byteOffset,
      fixtureData.byteLength,
    );
    // If the read slipped by ±8 on this real account it would return one of
    // these instead of 0n — which is what makes the next assertion meaningful.
    expect(dv.getBigUint64(V17_CREATOR_FEE_CLAIMABLE_ABS_OFF - 8, true)).not.toBe(0n);
    expect(dv.getBigUint64(V17_CREATOR_FEE_CLAIMABLE_ABS_OFF + 8, true)).not.toBe(0n);
  });

  it("reads 0n — pre-upgrade markets have zeroed padding there (back-compat)", () => {
    const claim = readCreatorFeeClaimable(fixtureData);
    expect(claim).not.toBeNull();
    expect(claim!.atoms).toBe(0n);
  });

  it("resolves the real on-chain insurance_operator, not the real marketauth", () => {
    const claim = readCreatorFeeClaimable(fixtureData)!;
    expect(claim.claimAuthority!.toBase58()).toBe(
      "FeDAMgMCs4RHoSmZg9egBKfQFyf4eZb98PLAqK88c2Ah",
    );
    expect(claim.claimAuthority!.toBase58()).not.toBe(
      "HLyBte5HgLjZRAfhXRXgzRFc4BXTqPVwadBHEUxY6ftD", // this market's marketauth
    );
  });
});

describe("readCreatorFeeClaimable — rejects what it must not decode", () => {
  it("returns null for a non-percolator account", () => {
    expect(readCreatorFeeClaimable(new Uint8Array(4096))).toBeNull();
  });

  it("returns null for a v17 PORTFOLIO account (same magic + version, kind 2)", () => {
    // Portfolio/ledger/registry accounts share the v17 magic and version and
    // carry NO WrapperConfigV16 — decoding one would render a fabricated
    // balance from unrelated bytes.
    const portfolio = makeV17Market(CLAIMABLE, 2);
    expect(readCreatorFeeClaimable(portfolio)).toBeNull();
  });

  it("returns null for a market account truncated before the config ends", () => {
    const truncated = makeV17Market(CLAIMABLE).slice(0, V17_MARKET_GROUP_OFF - 1);
    expect(readCreatorFeeClaimable(truncated)).toBeNull();
  });

  it("returns a claim with a null authority when the asset profile is missing", () => {
    // Config present, asset profile region absent: the balance is still real,
    // but "who may claim it" is unknown and must not be guessed.
    const noProfile = makeV17Market(CLAIMABLE).slice(0, PROFILE_OFF + 8);
    const claim = readCreatorFeeClaimable(noProfile);
    expect(claim).not.toBeNull();
    expect(claim!.atoms).toBe(CLAIMABLE);
    expect(claim!.claimAuthority).toBeNull();
  });
});

describe("isCreatorFeeClaimAuthority — gate for a future claim button", () => {
  const claim = readCreatorFeeClaimable(makeV17Market(CLAIMABLE))!;

  it("is true for the insurance_operator wallet", () => {
    expect(isCreatorFeeClaimAuthority(claim, OPERATOR)).toBe(true);
  });

  it("is false for marketauth (the staked-market pool PDA case)", () => {
    expect(isCreatorFeeClaimAuthority(claim, MARKETAUTH)).toBe(false);
  });

  it("fails closed for a disconnected wallet or an unknown claim", () => {
    expect(isCreatorFeeClaimAuthority(claim, null)).toBe(false);
    expect(isCreatorFeeClaimAuthority(claim, undefined)).toBe(false);
    expect(isCreatorFeeClaimAuthority(null, OPERATOR)).toBe(false);
    expect(isCreatorFeeClaimAuthority(undefined, OPERATOR)).toBe(false);
  });

  it("fails closed when the claim authority could not be resolved", () => {
    expect(
      isCreatorFeeClaimAuthority({ ...claim, claimAuthority: null }, OPERATOR),
    ).toBe(false);
  });
});
