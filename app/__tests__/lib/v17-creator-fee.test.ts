// @vitest-environment node
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
 *  - the claim authority is asserted to be asset 0's `asset_admin` and explicitly
 *    NOT `insurance_operator` (nor `marketauth`) — the divergence that keeps a
 *    staked market claimable by its creator rather than by a program PDA. The
 *    fixtures mirror the live staked market 7FBXdrm…, where the wizard rotated
 *    marketauth / insurance_authority / insurance_operator to PDAs while
 *    asset_admin stayed the creator wallet; a read that still used
 *    insurance_operator would return the PDA and fail these assertions;
 *  - dcccrypto/percolator-prog#507: since GH#420 the creator leg accrues PER
 *    ASSET, and only asset 0's admin can still draw down the legacy pot. A
 *    LIVE devnet fixture (`Azagguvr.market.json`, a real SOL market with legacy
 *    pot 0n and a real non-zero per-asset balance) pins the actual regression —
 *    reading the legacy pot alone silently returns 0n on this exact market,
 *    which is what shipped to production. Ground truth cross-checked three
 *    independent ways: the prog repo owner reading the deployed binary
 *    on-chain, a raw `DataView` read at absolute 1750, and the SDK's
 *    `parseAssetOracleProfileV17` — all agree on 4,358,743 atoms.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  V17_EXPECTED_VERSION,
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
const PROFILE_ASSET_ADMIN_REL = 368; // v17 asset_admin — the tag-90 claim authority

/** > 2^53: a Number() round-trip of this loses the low bits. */
const CLAIMABLE = 9_007_199_254_740_993n; // 2^53 + 1
const MARKETAUTH = new PublicKey("HLyBte5HgLjZRAfhXRXgzRFc4BXTqPVwadBHEUxY6ftD");
// Three DISTINCT authority keys, mirroring the live staked market 7FBXdrm…:
// insurance_operator is a program PDA the wizard rotated to; asset_admin stays the
// creator's wallet. Reading the wrong field returns a recognisably wrong claimant.
const OPERATOR = new PublicKey("6a3tiSd27Rh7JCnKLJQbJKUwRxVYEr33sUdHoJ64AZCg"); // insurance_operator PDA — NOT the claimant
const ASSET_ADMIN = new PublicKey("7JVQvrAfzj3aasLxCkoLYX5KQcrb5nEZhUe5Qa8PvV5G"); // asset_admin = creator wallet — the claimant
const MINT = new PublicKey("DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC");

function makeV17Market(claimable: bigint, kind: number = V17_KIND_MARKET): Uint8Array {
  const buf = Buffer.alloc(v17MarketAccountLen(1)); // 3147
  // header: magic "PERCV16\0" LE, version from the SDK (bumped 17 -> 18), kind
  buf.set([0x00, 0x36, 0x31, 0x56, 0x43, 0x52, 0x45, 0x50], 0);
  buf.writeUInt16LE(V17_EXPECTED_VERSION, 8);
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

  // asset 0 profile: asset_admin (rel 368) is the tag-90 claim authority. Write a
  // DIFFERENT key into insurance_operator (rel 56) too — the pre-2026-07-23 gate
  // read that field, so a regression would return OPERATOR instead of ASSET_ADMIN.
  buf.set(OPERATOR.toBytes(), PROFILE_OFF + PROFILE_INSURANCE_OPERATOR_REL);
  buf.set(ASSET_ADMIN.toBytes(), PROFILE_OFF + PROFILE_ASSET_ADMIN_REL);
  return new Uint8Array(buf);
}

// ── Real devnet market, captured pre-upgrade (584..592 still zeroed padding) ──
const fixture = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "BPgSUbDs.market.json"), "utf-8"),
) as { market: string; owner: string; dataLen: number; dataBase64: string };
/** The capture as-is: a version-17 header from the retired DhSkE7… wrapper. */
const fixtureDataV17Header = new Uint8Array(Buffer.from(fixture.dataBase64, "base64"));
/**
 * The same bytes with the header version set to 18. SDK 6+ (24d5d19d; pinned 8.0.0)
 * recognises only V17_EXPECTED_VERSION = 18 — every deployed market (wrapper ETDLAdi…)
 * is version 18 — so the raw capture is now (correctly) refused. The regions these
 * tests pin (config 584..592 and the asset-0 profile at 1350) sit at the same offsets
 * in v18, so only the version word is re-stamped to keep pinning them on real bytes.
 */
const fixtureData = (() => {
  const d = new Uint8Array(fixtureDataV17Header);
  new DataView(d.buffer).setUint16(8, 18, true);
  return d;
})();

// ── Real LIVE devnet market, captured 2026-09-28 (post-GH#420: the legacy
// config counter is 0, the per-asset counter is not) — pins the regression
// this fixes (dcccrypto/percolator-prog#507). Ground truth independently
// confirmed by the prog repo owner reading the same market with the deployed
// `a9318945` binary: asset 0 = 4,358,743 atoms.
const liveFixture = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "Azagguvr.market.json"), "utf-8"),
) as { market: string; owner: string; dataLen: number; dataBase64: string };
const liveFixtureData = new Uint8Array(Buffer.from(liveFixture.dataBase64, "base64"));
/** Ground truth for `liveFixtureData`, verified independently three ways: the
 * deployed wrapper's own on-chain state (percolator-prog#507 issue thread),
 * a raw DataView read at absolute offset 1750, and the SDK's
 * `parseAssetOracleProfileV17`. See lib/v17-creator-fee.ts's module doc. */
const LIVE_PER_ASSET_ATOMS = 4_358_743n;
const LIVE_LEGACY_POT_ATOMS = 0n;

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

  it("reports asset_admin as the claim authority, NOT insurance_operator or marketauth", () => {
    const claim = readCreatorFeeClaimable(data)!;
    expect(claim.claimAuthority).not.toBeNull();
    expect(claim.claimAuthority!.toBase58()).toBe(ASSET_ADMIN.toBase58());
    // insurance_operator and marketauth are DIFFERENT keys here on purpose: the
    // wizard rotates BOTH (plus insurance_authority) to program PDAs on a staked
    // market, so reading either would show a PDA — not the creator — as claimant.
    expect(claim.claimAuthority!.toBase58()).not.toBe(OPERATOR.toBase58());
    expect(claim.claimAuthority!.toBase58()).not.toBe(MARKETAUTH.toBase58());
  });

  it("formats to an exact decimal string for display (no float rounding)", () => {
    const claim = readCreatorFeeClaimable(data)!;
    expect(formatTokenAmount(claim.atoms, 6)).toBe("9007199254.740993");
  });
});

describe("readCreatorFeeClaimable — GH#420: sums asset 0's per-asset counter + the legacy pot", () => {
  /** `AssetOracleProfileV16.creator_fee_claimable_atoms` — profile-relative 400,
   * absolute 1750 for asset 0 (PROFILE_OFF + 400). The field this fix adds. */
  const PROFILE_CREATOR_FEE_REL = 400;

  function withPerAssetAccrual(data: Uint8Array, perAssetAtoms: bigint): Uint8Array {
    const buf = Buffer.from(data);
    buf.writeBigUInt64LE(perAssetAtoms, PROFILE_OFF + PROFILE_CREATOR_FEE_REL);
    return new Uint8Array(buf);
  }

  it("sits at absolute 1750 for asset 0", () => {
    expect(PROFILE_OFF + PROFILE_CREATOR_FEE_REL).toBe(1750);
  });

  it("adds the per-asset counter to a NONZERO legacy pot", () => {
    const LEGACY = 100n;
    const PER_ASSET = 9_000_000_000_000n; // > 2^32, catches a 32-bit-truncating regression too
    const data = withPerAssetAccrual(makeV17Market(LEGACY), PER_ASSET);
    const claim = readCreatorFeeClaimable(data)!;
    expect(claim.atoms).toBe(LEGACY + PER_ASSET);
  });

  it("is exactly the per-asset counter when the legacy pot is zero — the common post-GH#420 case", () => {
    // This is THE regression: every market seeded after GH#420 has legacy
    // pot 0n and all its real creator revenue in the per-asset counter. The
    // pre-fix code read `cfg.creatorFeeClaimableAtoms` alone here and would
    // have returned 0n — "nothing claimable" — while this balance sat unclaimed.
    const PER_ASSET = 4_358_743n; // the live SOL-market figure, see the fixture test below
    const data = withPerAssetAccrual(makeV17Market(0n), PER_ASSET);
    const claim = readCreatorFeeClaimable(data)!;
    expect(claim.atoms).toBe(PER_ASSET);
    expect(claim.atoms).not.toBe(0n);
  });

  it("keeps full u64 precision on the per-asset leg (bigint, never Number)", () => {
    const maxU64 = (1n << 64n) - 1n;
    const data = withPerAssetAccrual(makeV17Market(0n), maxU64);
    const claim = readCreatorFeeClaimable(data)!;
    expect(claim.atoms).toBe(maxU64);
  });
});

describe("readCreatorFeeClaimable — real LIVE devnet market (post-GH#420, percolator-prog#507)", () => {
  it("the fixture reproduces the bug's precondition: legacy pot is 0, per-asset counter is not", () => {
    const dv = new DataView(
      liveFixtureData.buffer,
      liveFixtureData.byteOffset,
      liveFixtureData.byteLength,
    );
    expect(dv.getBigUint64(V17_CREATOR_FEE_CLAIMABLE_ABS_OFF, true)).toBe(LIVE_LEGACY_POT_ATOMS);
    expect(dv.getBigUint64(PROFILE_OFF + 400, true)).toBe(LIVE_PER_ASSET_ATOMS);
  });

  it("reads the real per-asset balance, matching ground truth independently confirmed on-chain", () => {
    const claim = readCreatorFeeClaimable(liveFixtureData);
    expect(claim).not.toBeNull();
    expect(claim!.atoms).toBe(LIVE_PER_ASSET_ATOMS + LIVE_LEGACY_POT_ATOMS);
    expect(claim!.atoms).toBe(4_358_743n);
  });

  it("NEGATIVE CONTROL — the pre-fix read (legacy pot alone) is 0n on this market: an all-zero claimable would be the bug, not a coincidence", () => {
    // Pins the exact regression this fixes: reading ONLY
    // `cfg.creatorFeeClaimableAtoms` (what `readCreatorFeeClaimable` used to
    // return in full) is 0n here, even though the market has real unclaimed
    // creator revenue. If a future edit reverts to reading the legacy pot
    // alone, this fixture makes that regression fail loudly instead of
    // silently shipping a "$0.00 claimable" UI again.
    const dv = new DataView(
      liveFixtureData.buffer,
      liveFixtureData.byteOffset,
      liveFixtureData.byteLength,
    );
    const legacyPotAlone = dv.getBigUint64(V17_CREATOR_FEE_CLAIMABLE_ABS_OFF, true);
    const claim = readCreatorFeeClaimable(liveFixtureData)!;
    expect(legacyPotAlone).toBe(0n);
    expect(claim.atoms).not.toBe(legacyPotAlone);
    expect(claim.atoms).toBeGreaterThan(0n);
  });

  it("resolves the real on-chain asset_admin as claim authority", () => {
    const claim = readCreatorFeeClaimable(liveFixtureData)!;
    expect(claim.claimAuthority).not.toBeNull();
    expect(claim.claimAuthority!.toBase58()).toBe(
      "FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7",
    );
  });

  it("reports the collateral mint the payout is denominated in", () => {
    const claim = readCreatorFeeClaimable(liveFixtureData)!;
    expect(claim.collateralMint.toBase58()).toBe(
      "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC",
    );
  });
});

describe("readCreatorFeeClaimable — real devnet market (pre-upgrade padding)", () => {
  it("refuses the raw version-17 capture (retired wrapper) instead of guessing at it", () => {
    expect(new DataView(fixtureDataV17Header.buffer).getUint16(8, true)).toBe(17);
    expect(readCreatorFeeClaimable(fixtureDataV17Header)).toBeNull();
  });

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

  it("resolves the real on-chain asset_admin, not insurance_operator or marketauth", () => {
    const claim = readCreatorFeeClaimable(fixtureData)!;
    // Captured BPgSUbDs carries three DISTINCT authority keys, so this pins the
    // read to asset_admin rather than any adjacent authority field.
    expect(claim.claimAuthority!.toBase58()).toBe(
      "FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7", // asset_admin
    );
    expect(claim.claimAuthority!.toBase58()).not.toBe(
      "FeDAMgMCs4RHoSmZg9egBKfQFyf4eZb98PLAqK88c2Ah", // insurance_operator — the OLD gate
    );
    expect(claim.claimAuthority!.toBase58()).not.toBe(
      "HLyBte5HgLjZRAfhXRXgzRFc4BXTqPVwadBHEUxY6ftD", // marketauth
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

describe("isCreatorFeeClaimAuthority — gate for the claim button", () => {
  const claim = readCreatorFeeClaimable(makeV17Market(CLAIMABLE))!;

  it("is true for the asset_admin wallet (the creator)", () => {
    expect(isCreatorFeeClaimAuthority(claim, ASSET_ADMIN)).toBe(true);
  });

  it("is false for insurance_operator (rotated to a PDA on a staked market)", () => {
    // The pre-2026-07-23 gate returned true here; the deployed tag-90 handler
    // rejects it, so the button must NOT render for this wallet.
    expect(isCreatorFeeClaimAuthority(claim, OPERATOR)).toBe(false);
  });

  it("is false for marketauth (the staked-market pool PDA case)", () => {
    expect(isCreatorFeeClaimAuthority(claim, MARKETAUTH)).toBe(false);
  });

  it("fails closed for a disconnected wallet or an unknown claim", () => {
    expect(isCreatorFeeClaimAuthority(claim, null)).toBe(false);
    expect(isCreatorFeeClaimAuthority(claim, undefined)).toBe(false);
    expect(isCreatorFeeClaimAuthority(null, ASSET_ADMIN)).toBe(false);
    expect(isCreatorFeeClaimAuthority(undefined, ASSET_ADMIN)).toBe(false);
  });

  it("fails closed when the claim authority could not be resolved", () => {
    expect(
      isCreatorFeeClaimAuthority({ ...claim, claimAuthority: null }, ASSET_ADMIN),
    ).toBe(false);
  });
});
