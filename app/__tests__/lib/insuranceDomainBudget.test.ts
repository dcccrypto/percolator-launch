import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { V17_MARKET_ASSET_SLOT_LEN } from "@percolatorct/sdk";
import {
  SLOTS_BASE,
  ASSET_SLOT_WRAPPER_PREFIX,
  INSURANCE_DOMAIN_BUDGET_LONG_REL,
  INSURANCE_DOMAIN_BUDGET_SHORT_REL,
  PROFILE_INSURANCE_OPERATOR_REL,
  slotBase,
  marketAssetCapacity,
  readInsuranceDomainBudget,
  readAssetInsuranceOperator,
} from "@/lib/insuranceDomainBudget";

/**
 * Verifies the per-asset insurance_domain_budget + insurance_operator readers
 * against the on-chain layout confirmed via `cargo run --example dump_layout`
 * AND against live devnet market GsBBecjFRwUvsrJ3bCinmCqDhERGtop9BKKEkE8SVa1C
 * (budget_long 2502588437 + budget_short 2502588438 == group insurance 5005176875).
 */

function writeU128LE(buf: Uint8Array, offset: number, value: bigint) {
  let v = value;
  for (let i = 0; i < 16; i++) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function makeMarketBuffer(capacity: number): Uint8Array {
  return new Uint8Array(SLOTS_BASE + capacity * V17_MARKET_ASSET_SLOT_LEN);
}

const OPERATOR = new PublicKey("FbTbDeGWQpjrEqJdqoBHX3sTWHoAmU2xywD7wyxH6WC7");

describe("insuranceDomainBudget readers", () => {
  it("infers asset capacity from the account length (single-asset market)", () => {
    // 3003 = the exact on-chain length of a cap-1 v17 market.
    expect(SLOTS_BASE + 1 * V17_MARKET_ASSET_SLOT_LEN).toBe(3003);
    expect(marketAssetCapacity(makeMarketBuffer(1))).toBe(1);
    expect(marketAssetCapacity(makeMarketBuffer(10))).toBe(10);
  });

  it("returns 0 capacity for buffers too short to hold the group header", () => {
    expect(marketAssetCapacity(new Uint8Array(100))).toBe(0);
  });

  it("reads insurance_domain_budget as long+short of the asset's two domains", () => {
    const buf = makeMarketBuffer(1);
    const base = slotBase(0);
    // Exact live-market values — their sum equalled the group insurance on-chain.
    writeU128LE(buf, base + ASSET_SLOT_WRAPPER_PREFIX + INSURANCE_DOMAIN_BUDGET_LONG_REL, 2_502_588_437n);
    writeU128LE(buf, base + ASSET_SLOT_WRAPPER_PREFIX + INSURANCE_DOMAIN_BUDGET_SHORT_REL, 2_502_588_438n);
    expect(readInsuranceDomainBudget(buf, 0)).toBe(5_005_176_875n);
  });

  it("does NOT read the OI field (a value that can legitimately be zero)", () => {
    const buf = makeMarketBuffer(1);
    const base = slotBase(0);
    // oi_eff_long_q is at wrapper+273 — writing it must NOT affect the budget read.
    writeU128LE(buf, base + ASSET_SLOT_WRAPPER_PREFIX + 273, 999_999n);
    writeU128LE(buf, base + ASSET_SLOT_WRAPPER_PREFIX + 289, 888_888n);
    expect(readInsuranceDomainBudget(buf, 0)).toBe(0n);
  });

  it("reads distinct budgets per asset in a multi-asset market", () => {
    const buf = makeMarketBuffer(3);
    for (let i = 0; i < 3; i++) {
      const base = slotBase(i);
      writeU128LE(buf, base + ASSET_SLOT_WRAPPER_PREFIX + INSURANCE_DOMAIN_BUDGET_LONG_REL, BigInt((i + 1) * 100));
      writeU128LE(buf, base + ASSET_SLOT_WRAPPER_PREFIX + INSURANCE_DOMAIN_BUDGET_SHORT_REL, BigInt((i + 1) * 50));
    }
    expect(readInsuranceDomainBudget(buf, 0)).toBe(150n);
    expect(readInsuranceDomainBudget(buf, 1)).toBe(300n);
    expect(readInsuranceDomainBudget(buf, 2)).toBe(450n);
  });

  it("throws when the asset slot is not fully contained in the buffer", () => {
    const buf = makeMarketBuffer(1);
    expect(() => readInsuranceDomainBudget(buf, 1)).toThrow(/out of range/);
  });

  it("reads insurance_operator from the per-asset profile (offset 56 in the slot)", () => {
    const buf = makeMarketBuffer(1);
    const off = slotBase(0) + PROFILE_INSURANCE_OPERATOR_REL;
    buf.set(OPERATOR.toBytes(), off);
    const read = readAssetInsuranceOperator(buf, 0);
    expect(read?.toBase58()).toBe(OPERATOR.toBase58());
  });

  it("returns null when the operator slot is out of range", () => {
    const buf = makeMarketBuffer(1);
    expect(readAssetInsuranceOperator(buf, 5)).toBeNull();
  });
});
