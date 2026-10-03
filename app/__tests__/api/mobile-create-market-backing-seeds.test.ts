// @vitest-environment node
//
// Node, not jsdom. PDA derivation hashes its seeds, and under jsdom the Buffer it
// is handed fails @noble/hashes' Uint8Array check, so deriveLpBackingLedger throws
// "Unable to find a viable program address nonce" — an environment artefact, not a
// derivation problem. The same thing breaks PublicKey.createWithSeed in the route.
/**
 * GH#2595 — a mobile market launch must seed BOTH backing domains, with the right
 * amount, the right lane and a non-expiring bucket.
 *
 * The route seeded neither, and said so: "this flow seeds no backing, so insurance
 * is the first consumer of the shared one-shot lane (intentId 1)". Two reasons that
 * diverged from the web launch, both documented in hooks/useCreateMarket.ts:
 *
 *   1. Counterparty backing for shorts. At BACKING_SEED_PCT_OF_LP = 100 the seed
 *      is a real amount, not dust (lib/market-params.ts:110-129).
 *   2. The backing-bucket freshness deadlock. The MECHANISM is the MAX expiry:
 *      "fresh_counterparty_backing_expiry_slot() then always returns this same MAX
 *      value, so every later automatic loss-reserve request matches the existing
 *      expiry and hits the harmless no-op arm" (useCreateMarket.ts:3118-3123).
 *      Buckets being Empty is the WINDOW in which seeding is safe, not the thing
 *      that prevents the trap — an earlier version of this fix put the causality
 *      on Emptiness, which is a gloss the repo does not make. Note also that the
 *      repo does not establish that an Empty bucket is itself dangerous, so reason
 *      2 is plausible rather than devnet-verified; reason 1 is the dated one.
 *
 * WHY THIS FILE DECODES INSTRUCTIONS INSTEAD OF MATCHING SOURCE TEXT.
 *
 * The first version asserted on the route's source, because the handler cannot be
 * driven in a test (GH#2542: "Account count mismatch: expected 3, got 9"). Review
 * built a harness, ran 33 mutants against those assertions, and **21 survived** —
 * including seeding the LONG domain twice (`domain: 0`), paying 10% of LP, a FINITE
 * expirySlot that re-arms the deadlock, both domains sharing lane 1, and both
 * ledgers pointing at the slab. All of those change a VALUE, and source matching
 * only saw TEXT. Worse, comments were never stripped, so one added comment line
 * could hijack an anchor and revert the whole change with a green suite.
 *
 * The funding instructions are now built by lib/mobile-market-funding-ixs.ts, which
 * needs no network and no mocks, so every value is asserted by comparing encoded
 * instruction data byte-for-byte against a reference encoding. Reference encodings
 * rather than hand-computed offsets: the layout stays the SDK's business.
 *
 * GH#2749 — HOW the domains are funded changed. The two direct TopUpBackingBucket
 * seeds carried expiry MAX_BACKING_BUCKET_EXPIRY_SLOT (u64::MAX / 2), which is the
 * wrapper's reserved LP_VAULT_BACKING_EXPIRY_SLOT: handle_top_up_backing_bucket
 * refuses it with InvalidInstruction (Custom 9) whenever amount != 0
 * (percolator-prog 553d76f0, v16_program.rs ~L17362/~L17422), so TX4 reverted on
 * every launch. The seed group is now the web launch's C-1 path
 * (lib/earn-vault-seed.ts): CreateLpVault(0) + LP-share ATA + DepositToLpVault(0, 1),
 * which stamps the sentinel itself. A direct MAX - 1 seed would land but make
 * CreateLpVault refuse forever (Custom 63), so "no direct top-up at all" is asserted.
 */

import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  encodeTopUpBackingBucket,
  encodeTopUpInsurance,
  encodeDepositCollateral,
  encodeCreateLpVaultV17,
  encodeDepositToLpVault,
  deriveLpBackingLedger,
  deriveLpVaultRegistry,
  deriveInsuranceLpMint,
  WELL_KNOWN,
  MAX_BACKING_BUCKET_EXPIRY_SLOT,
} from "@percolatorct/sdk";
import { backingSeedPerDomain, BACKING_SEED_PCT_OF_LP } from "@/lib/market-params";
import {
  EARN_VAULT_FEE_SHARE_BPS,
  EARN_VAULT_OI_RESERVATION_BPS,
  EARN_VAULT_COOLDOWN_SLOTS,
} from "@/lib/earn-vault-seed";
import {
  buildMobileFundingIxs,
  mobileRequiredCollateral,
  DEFAULT_LP_COLLATERAL,
  DEFAULT_INSURANCE,
  MIN_INIT_MARKET_SEED,
} from "@/lib/mobile-market-funding-ixs";

const programId = new PublicKey("69VUZ7a2BeXBTpRRManLamF5UWTaNR9B1hy5Se3cdXy9");
// Fixed, not Keypair.generate(): a random market pubkey can leave
// deriveLpBackingLedger with no viable PDA nonce, which made this file fail about
// as often as it passed. Deterministic bytes keep the run reproducible.
const fixedKey = (fill: number) => new PublicKey(new Uint8Array(32).fill(fill));
const market = fixedKey(7);
const lpPortfolio = fixedKey(11);
// The deployer is a wallet, so it must be ON the curve: the seed group derives the
// deployer's LP-share ATA, which refuses an off-curve owner. Deterministic seed.
const deployer = Keypair.fromSeed(new Uint8Array(32).fill(13)).publicKey;
const userAta = fixedKey(17);
const vaultAta = fixedKey(19);

const funding = buildMobileFundingIxs({ programId, market, lpPortfolio, deployer, userAta, vaultAta });
/** Every instruction the launch issues, for presence/absence checks. */
const ixs = [...funding.mandatory, ...funding.backingSeeds];
const seed = backingSeedPerDomain(DEFAULT_LP_COLLATERAL);

const [registry] = deriveLpVaultRegistry(programId, market);
const [lpMint] = deriveInsuranceLpMint(programId, market);
const [ledger0] = deriveLpBackingLedger(programId, market, 0);
const [ledger1] = deriveLpBackingLedger(programId, market, 1);

/** Reference encodings, built from the SDK encoders directly (not via the module under test). */
const createVaultData = Buffer.from(
  encodeCreateLpVaultV17({
    feeShareBps: EARN_VAULT_FEE_SHARE_BPS,
    oiReservationThresholdBps: EARN_VAULT_OI_RESERVATION_BPS,
    redemptionCooldownSlots: EARN_VAULT_COOLDOWN_SLOTS,
    domain: 0,
  }),
);
const depositVaultData = (domain: number, amount: bigint = seed) =>
  Buffer.from(encodeDepositToLpVault({ amount: amount.toString(), domain }));

/** The instruction tag every TopUpBackingBucket starts with (from the SDK's own encoder). */
const TOP_UP_BACKING_TAG = Buffer.from(
  encodeTopUpBackingBucket({
    domain: 0,
    marketId: 1n,
    intentId: 2n,
    authorityEpoch: 0n,
    amount: "1",
    expirySlot: "1",
  }),
)[0];

const insuranceData = (lane: bigint) =>
  Buffer.from(
    encodeTopUpInsurance({
      marketId: 1n,
      intentId: lane,
      authorityEpoch: 0n,
      amount: DEFAULT_INSURANCE.toString(),
    }),
  );

const dataOf = (ix: { data: Buffer | Uint8Array }) => Buffer.from(ix.data);
const indexOfData = (buf: Buffer) => funding.backingSeeds.findIndex((ix) => dataOf(ix).equals(buf));

describe("GH#2749: no direct TopUpBackingBucket is ever sent", () => {
  it("no instruction in either group is a TopUpBackingBucket (Custom 9 at u64::MAX/2; Custom 63 later at any other expiry)", () => {
    // Our program's instructions only; the ATA instruction belongs to another program.
    const ours = ixs.filter((ix) => ix.programId.equals(programId));
    expect(ours.length).toBeGreaterThan(0);
    for (const ix of ours) expect(dataOf(ix)[0]).not.toBe(TOP_UP_BACKING_TAG);
  });

  it("CONTROL: the bytes the old seeds carried are absent, and that expiry is the wrapper sentinel", () => {
    // u64::MAX / 2 — the value handle_top_up_backing_bucket rejects (553d76f0).
    expect(MAX_BACKING_BUCKET_EXPIRY_SLOT).toBe(18446744073709551615n / 2n);
    for (const domain of [0, 1]) {
      const old = Buffer.from(
        encodeTopUpBackingBucket({
          domain,
          marketId: 1n,
          intentId: BigInt(domain) + 2n,
          authorityEpoch: 0n,
          amount: seed.toString(),
          expirySlot: MAX_BACKING_BUCKET_EXPIRY_SLOT.toString(),
        }),
      );
      expect(ixs.some((ix) => dataOf(ix).equals(old))).toBe(false);
    }
  });
});

describe("both backing domains are funded through the Earn vault (C-1 path)", () => {
  it("is exactly CreateLpVault, the LP-share ATA, then a deposit into domain 0 and domain 1", () => {
    expect(funding.backingSeeds).toHaveLength(4);
    expect(dataOf(funding.backingSeeds[0]).equals(createVaultData)).toBe(true);
    expect(funding.backingSeeds[1].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(indexOfData(depositVaultData(0))).toBe(2);
    expect(indexOfData(depositVaultData(1))).toBe(3);
  });

  it("creates the vault BEFORE either deposit (CreateLpVault needs Empty buckets)", () => {
    const create = indexOfData(createVaultData);
    expect(create).toBe(0);
    expect(indexOfData(depositVaultData(0))).toBeGreaterThan(create);
    expect(indexOfData(depositVaultData(1))).toBeGreaterThan(create);
  });

  it("pays the policy amount into each domain, floor included", () => {
    expect(seed).toBe(DEFAULT_LP_COLLATERAL); // 100% of LP at today's policy
    const tenPct = (DEFAULT_LP_COLLATERAL * 10n) / 100n;
    for (const domain of [0, 1]) {
      expect(indexOfData(depositVaultData(domain, tenPct))).toBe(-1);
    }
  });

  it("CreateLpVault is signed by the deployer (marketauth on this route) over the market's own registry and mint PDAs", () => {
    const ix = funding.backingSeeds[0];
    expect(ix.programId.equals(programId)).toBe(true);
    expect(ix.keys[0].pubkey.equals(deployer) && ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(market)).toBe(true);
    expect(ix.keys[2].pubkey.equals(registry)).toBe(true);
    expect(ix.keys[3].pubkey.equals(lpMint)).toBe(true);
  });

  it("each deposit draws from the deployer's ATA into the market vault, with domain 0's ledger and domain 1 as sibling", () => {
    const lpAta = getAssociatedTokenAddressSync(lpMint, deployer, false, WELL_KNOWN.tokenProgram);
    expect(ledger0.equals(ledger1)).toBe(false);
    for (const domain of [0, 1]) {
      const ix = funding.backingSeeds[indexOfData(depositVaultData(domain))];
      const k = ix.keys.map((m) => m.pubkey);
      expect(ix.keys[0].pubkey.equals(deployer) && ix.keys[0].isSigner).toBe(true);
      expect(k[1].equals(market)).toBe(true);
      expect(k[2].equals(registry)).toBe(true);
      expect(k[3].equals(lpMint)).toBe(true);
      expect(k[4].equals(lpAta)).toBe(true);
      expect(k[5].equals(userAta)).toBe(true);
      expect(k[6].equals(vaultAta)).toBe(true);
      // The wrapper derives `ledger` from registry.domain (0) and the sibling from domain 1.
      expect(k[7].equals(ledger0)).toBe(true);
      expect(k[10].equals(ledger1)).toBe(true);
    }
  });
});

describe("the one-shot intent lane", () => {
  it("insurance keeps lane 1, in the mandatory group", () => {
    // `intentId` is a strictly-increasing one-shot NONCE, not the CAS — the CAS is
    // `authorityEpoch`, 0 on every instruction here. The Earn-vault seed group
    // consumes no lane at all.
    expect(funding.mandatory.some((ix) => dataOf(ix).equals(insuranceData(1n)))).toBe(true);
  });

  it("the mandatory group runs deposit, then insurance, then the crank", () => {
    const deposit = Buffer.from(
      encodeDepositCollateral({
        portfolioId: 1n,
        expectedSequence: 1n,
        amount: DEFAULT_LP_COLLATERAL.toString(),
      }),
    );
    const idx = (buf: Buffer) => funding.mandatory.findIndex((ix) => dataOf(ix).equals(buf));
    expect(idx(deposit)).toBe(0);
    expect(idx(insuranceData(1n))).toBeGreaterThan(idx(deposit));
    expect(funding.mandatory).toHaveLength(3);
  });
});

describe("the seeds are NOT in the load-bearing transaction (GH#2514 policy)", () => {
  it("the mandatory group carries no backing instruction", () => {
    // GH#2514 settled that seeding is non-fatal. Bundling it with the deposit would
    // make a non-fatal step fatal AND raise that transaction's draw from 1,100 to
    // 3,000 tokens.
    for (const buf of [createVaultData, depositVaultData(0), depositVaultData(1)]) {
      expect(funding.mandatory.some((ix) => dataOf(ix).equals(buf))).toBe(false);
    }
  });

  it("the seed group carries nothing load-bearing", () => {
    const deposit = Buffer.from(
      encodeDepositCollateral({
        portfolioId: 1n,
        expectedSequence: 1n,
        amount: DEFAULT_LP_COLLATERAL.toString(),
      }),
    );
    expect(funding.backingSeeds.some((ix) => dataOf(ix).equals(deposit))).toBe(false);
    expect(funding.backingSeeds.some((ix) => dataOf(ix).equals(insuranceData(1n)))).toBe(false);
  });
});

describe("the collateral requirement is reported, and is right", () => {
  it("is the sum of every amount the flow actually draws", () => {
    // Read from the SAME module the route reports from, so a wrong expression in
    // the route cannot pass by the test restating the right one — which is how
    // five wrong-value mutants survived the previous version.
    expect(mobileRequiredCollateral()).toBe(
      MIN_INIT_MARKET_SEED + DEFAULT_LP_COLLATERAL + DEFAULT_INSURANCE + 2n * seed,
    );
    expect(mobileRequiredCollateral()).toBe(3_600_000_000n);
  });

  it("includes BOTH backing seeds, not one and not none", () => {
    expect(mobileRequiredCollateral()).not.toBe(
      MIN_INIT_MARKET_SEED + DEFAULT_LP_COLLATERAL + DEFAULT_INSURANCE + seed,
    );
    // The pre-fix total, which the commit says a wallet cannot finish TX3 with.
    expect(mobileRequiredCollateral()).not.toBe(1_600_000_000n);
  });

  it("includes the vault seed, which this flow — unlike the web one — transfers", () => {
    expect(mobileRequiredCollateral()).toBeGreaterThan(
      DEFAULT_LP_COLLATERAL + DEFAULT_INSURANCE + 2n * seed,
    );
  });

  it("CONTROL: the policy behind the 3,600 is still 100% of LP", () => {
    expect(BACKING_SEED_PCT_OF_LP).toBe(100n);
  });
});
