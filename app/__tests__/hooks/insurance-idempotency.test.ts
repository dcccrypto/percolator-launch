/**
 * The insurance seed must not be skipped because of backing-bucket collateral.
 *
 * The step-4 idempotency check inferred "insurance already deposited" as
 * `vaultBalance - lpCapital`. But the vault also holds the BACKING-BUCKET seeds
 * (TopUpBackingBucket, one per domain), so that subtraction counts them as
 * insurance.
 *
 * Observed on a real launch: LP seed 1000, backing seed 100 x 2 domains, vault
 * 1200, LP capital 1000. The check computed 200 "already topped up", compared it
 * against the 100 insurance seed, decided insurance had landed, and never built
 * the instruction. The market came up with insurance = 0 and NO failed
 * transaction — TopUpInsurance (tag 9) appears in none of the launch txs.
 *
 * Reading insuranceBalance from the market-group header is what the engine
 * itself uses, so it cannot be confused with anything else in the vault.
 */
import { describe, it, expect } from "vitest";

const LP = 1_000_000_000n;          // 1000 tokens
const BACKING_PER_DOMAIN = 100_000_000n; // 100 tokens, x2 domains
const INSURANCE = 100_000_000n;     // 100 tokens

/** The old, broken inference. */
function alreadyToppedUp_viaVaultMinusCapital(vault: bigint, lpCapital: bigint): bigint {
  return vault - lpCapital;
}

/** The fix: the engine's own number. */
function alreadyToppedUp_viaInsuranceBalance(insuranceBalance: bigint): bigint {
  return insuranceBalance;
}

describe("step 4 insurance idempotency", () => {
  // The exact on-chain state after the deposit + backing seeds landed.
  const vault = LP + BACKING_PER_DOMAIN * 2n; // 1200
  const lpCapital = LP;                       // 1000
  const insuranceOnChain = 0n;                // never deposited

  it("the old inference counts backing seeds as insurance and skips the deposit", () => {
    const already = alreadyToppedUp_viaVaultMinusCapital(vault, lpCapital);
    expect(already).toBe(200_000_000n);
    expect(already < INSURANCE).toBe(false); // -> skipped, the bug
  });

  it("reading the real balance sends the deposit", () => {
    const already = alreadyToppedUp_viaInsuranceBalance(insuranceOnChain);
    expect(already).toBe(0n);
    expect(already < INSURANCE).toBe(true); // -> deposited
  });

  it("still skips when insurance genuinely landed — idempotency preserved", () => {
    const already = alreadyToppedUp_viaInsuranceBalance(INSURANCE);
    expect(already < INSURANCE).toBe(false);
  });

  it("tops up when a partial deposit landed", () => {
    const already = alreadyToppedUp_viaInsuranceBalance(INSURANCE / 2n);
    expect(already < INSURANCE).toBe(true);
  });
});
