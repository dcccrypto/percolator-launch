/**
 * The funding instructions of a mobile market launch: the LP deposit, one backing
 * seed per domain, the insurance top-up and the closing crank.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * It used to be inline in /api/mobile/create-market's POST handler, which cannot
 * be driven from a test: it 500s with "Account count mismatch: expected 3, got 9"
 * (GH#2542, SDK 6.0.0 account specs against stale v17 key lists) before it
 * finishes building, and under jsdom it fails even earlier inside
 * PublicKey.createWithSeed. So the only available instrument was matching the
 * route's source text.
 *
 * That turned out to be worth very little. Review of GH#2595 ran 33 mutants
 * against those source assertions and 21 survived, including: seeding the LONG
 * domain twice (`domain: 0`), paying 10% of LP instead of the policy amount,
 * a finite `expirySlot` (which re-arms the very deadlock the seeding prevents),
 * both domains sharing intent lane 1, and pointing both ledgers at the slab.
 * Every one of those changes a VALUE, and the assertions only checked that
 * certain TEXT appeared somewhere — including inside comments, which were never
 * stripped, so a single added comment line could hijack an anchor and revert the
 * whole change with a green suite.
 *
 * Extracting the builder makes the values assertable: a test can call this,
 * decode the instructions it returns, and compare them byte-for-byte against a
 * reference encoding. Nothing here touches the network, so it needs no mocks.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  encodeDepositCollateral,
  encodeTopUpInsurance,
  encodePermissionlessCrank,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_PERMISSIONLESS_CRANK_BASE,
  buildAccountMetas,
  buildIx,
  deriveLpVaultRegistry,
  deriveInsuranceLpMint,
  WELL_KNOWN,
} from "@percolatorct/sdk";
import { backingSeedPerDomain } from "@/lib/market-params";
import { buildEarnVaultSeedInstructions } from "@/lib/earn-vault-seed";
import { defaultCrankObservations } from "@/lib/v18-wire";

/** Minimum token amount for the vault seed transfer (matches the on-chain guard). */
export const MIN_INIT_MARKET_SEED = 500_000_000n;
/** Default LP collateral deposit (1,000 tokens raw at 6 decimals). */
export const DEFAULT_LP_COLLATERAL = 1_000_000_000n;
/** Default insurance fund seed (100 tokens raw at 6 decimals). */
export const DEFAULT_INSURANCE = 100_000_000n;

/**
 * Total collateral a mobile launch draws from the deployer's token account.
 *
 * Includes MIN_INIT_MARKET_SEED, which this flow really does transfer (TX0) —
 * unlike the web launch, where the W11 fix removed that transfer. Seeding backing
 * raised this from 1,600 to 3,600 tokens at the current 100%-of-LP policy, and
 * this route has no pre-fund step of its own.
 */
export function mobileRequiredCollateral(): bigint {
  return (
    MIN_INIT_MARKET_SEED +
    DEFAULT_LP_COLLATERAL +
    DEFAULT_INSURANCE +
    2n * backingSeedPerDomain(DEFAULT_LP_COLLATERAL)
  );
}

export interface FundingIxParams {
  programId: PublicKey;
  /** The market (slab) account. */
  market: PublicKey;
  /** The LP portfolio created in TX1. */
  lpPortfolio: PublicKey;
  /** Deployer — signer, and the default backing_bucket_authority on a fresh market. */
  deployer: PublicKey;
  /** Deployer's collateral token account; every amount below is drawn from it. */
  userAta: PublicKey;
  /** The market vault's token account. */
  vaultAta: PublicKey;
}

export interface MobileFundingIxs {
  /** Load-bearing: the LP deposit, the insurance top-up and the closing crank. */
  mandatory: TransactionInstruction[];
  /**
   * The backing seed group (Earn vault create + one deposit per domain).
   * SEPARATE, and deliberately so.
   *
   * GH#2514 settled that seeding is NON-FATAL: "a transient RPC error must not
   * strand a live market, and a repeat TopUp against an already-Fresh-at-MAX
   * bucket is a harmless no-op". The web launch honours that by surfacing
   * `backingSeedFailed` instead of failing the launch.
   *
   * Putting them in the deposit's transaction would break that policy twice over:
   * it makes a non-fatal step fatal, and it raises that transaction's draw from
   * 1,100 to 3,000 tokens, so the commonest outcome of an under-funded wallet
   * becomes a reverted LP deposit on a launch that previously succeeded.
   *
   * The group is atomic: if it never lands nothing in it applied, the market is
   * still live, both buckets stay Empty, and the creator (still marketauth and
   * backing authority) can create the Earn vault later.
   */
  backingSeeds: TransactionInstruction[];
}

/**
 * Build the funding instructions, grouped by whether they are load-bearing.
 *
 * The route sends `mandatory` (TX3) before `backingSeeds` (TX4). The seed group
 * consumes no `intentId` lane, so this order is no longer load-bearing for the
 * one-shot nonce; it is kept so the non-fatal group always runs last.
 */
export function buildMobileFundingIxs(p: FundingIxParams): MobileFundingIxs {
  const { programId, market, lpPortfolio, deployer, userAta, vaultAta } = p;

  // v17 Deposit: [owner(s,w), market(w), portfolio(w), sourceToken(w), vaultToken(w), tokenProgram]
  // v18 fresh-market: LP portfolioId 1; matcher-seq is 1 (SetMatcherConfig in TX2
  // advanced it 0 -> 1). Named-map form (GH#2542 follow-up) — order already matched
  // the spec, but positional form silently breaks on any future SDK reorder.
  const depositIx = buildIx({
    programId,
    keys: buildAccountMetas(ACCOUNTS_DEPOSIT_COLLATERAL, {
      owner: deployer,
      market,
      portfolio: lpPortfolio,
      sourceToken: userAta,
      vaultToken: vaultAta,
      tokenProgram: WELL_KNOWN.tokenProgram,
    }),
    data: encodeDepositCollateral({
      portfolioId: 1n,
      expectedSequence: 1n,
      amount: DEFAULT_LP_COLLATERAL.toString(),
    }),
  });

  /**
   * Backing for BOTH asset-0 domains (GH#2595), funded through the Earn vault
   * exactly like the web launch (lib/earn-vault-seed.ts, bug C-1):
   * CreateLpVault(domain 0) + LP-share ATA + DepositToLpVault(domain 0 and 1).
   *
   * GH#2749: this used to be two direct TopUpBackingBucket seeds at
   * MAX_BACKING_BUCKET_EXPIRY_SLOT (u64::MAX / 2). That value IS the wrapper's
   * reserved LP_VAULT_BACKING_EXPIRY_SLOT, and handle_top_up_backing_bucket
   * refuses it with InvalidInstruction (Custom 9) whenever amount != 0
   * (percolator-prog 553d76f0, v16_program.rs ~L17362 and ~L17422), so this
   * transaction reverted on every launch. Moving to MAX - 1 would land, but a
   * domain funded at any expiry other than the sentinel makes CreateLpVault
   * refuse forever with LpVaultBackingBucketNotEmpty (Custom 63) — the exact state
   * C-1 removed from the web launch. DepositToLpVault stamps the sentinel itself,
   * so the buckets never lapse (the Custom(21) freshness deadlock stays closed).
   *
   * Preconditions, all true at this point on this route: market Live, signer ==
   * marketauth (the deployer, InitMarket signer), both buckets still Empty. No
   * intent lane or authority epoch is consumed, so insurance's lane 1 is
   * unaffected. The deployer receives the LP shares for the same collateral the
   * direct seeds drew (backingSeedPerDomain x 2).
   */
  const [registry] = deriveLpVaultRegistry(programId, market);
  const [lpMint] = deriveInsuranceLpMint(programId, market);
  const backingIxs = buildEarnVaultSeedInstructions({
    programId,
    wallet: deployer,
    market,
    registry,
    lpMint,
    userAta,
    vaultAta,
    seedPerDomain: backingSeedPerDomain(DEFAULT_LP_COLLATERAL),
    includeCreate: true,
  });

  // Insurance keeps one-shot lane 1 and runs in the mandatory group, before the
  // seeds take 2 and 3.
  //
  // `intentId` is a strictly-increasing one-shot nonce, NOT the CAS — the CAS is
  // `authorityEpoch`, which is 0 for every instruction here. So a reused lane does
  // not "collide" with another instruction; the instruction presenting the
  // already-consumed lane is itself rejected as a replay.
  const insuranceIx = buildIx({
    programId,
    keys: buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, {
      signer: deployer,
      market,
      sourceToken: userAta,
      vaultToken: vaultAta,
      tokenProgram: WELL_KNOWN.tokenProgram,
    }),
    data: encodeTopUpInsurance({
      marketId: 1n,
      intentId: 1n,
      authorityEpoch: 0n,
      amount: DEFAULT_INSURANCE.toString(),
    }),
  });

  // v17 PermissionlessCrank: [owner(s,w), market(w), portfolio(w)] — no oracle
  // tail for an admin-oracle market.
  const crankIx = buildIx({
    programId,
    keys: buildAccountMetas(ACCOUNTS_PERMISSIONLESS_CRANK_BASE, {
      owner: deployer,
      market,
      portfolio: lpPortfolio,
    }),
    data: encodePermissionlessCrank({ nowSlot: 0n, observations: defaultCrankObservations(0) }),
  });

  return { mandatory: [depositIx, insuranceIx, crankIx], backingSeeds: backingIxs };
}
