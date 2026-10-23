// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { LAYOUT_V22, STAKE_POOL_FIELD_OFF_V5, STAKE_POOL_SIZE_V5, STAKE_RISK_MODE, INSURANCE_UNITS_FIELD_OFF_V22, ACCOUNT_KIND, WRAPPER_ACCOUNT_MAGIC, deriveInsuranceUnitsV22 } from "@/lib/v22/sdk";
import { buildRecoverTerminalInsuranceIx, planStakeWindDown } from "@/lib/v22/sdk/records/stake-wind-down";
import { liveFreeInsuranceAtoms, stakeWithdrawCapView } from "@/lib/v22/stake-pool-value";
import { withdrawAmountError } from "@/lib/stake-position";
import { V22_COPY } from "@/lib/v22/copy";
import { syntheticMarket } from "./_stamp";

const k = () => Keypair.generate().publicKey;

describe("tag 29 account tail (stake 53f5480 processor.rs:4148-4150, 4224-4260)", () => {
  const base = { stakeProgram: k(), caller: k(), pool: k(), poolVault: k(), vaultAuth: k(), market: k(), wrapperVault: k(), wrapperVaultAuthority: k(), wrapperProgram: k() };
  it("FIRST_LOSS: [9] units [10] creator, writable non-signers; short lists refused", () => {
    const insuranceUnits = k(), creatorToken = k();
    const ix = buildRecoverTerminalInsuranceIx({ ...base, riskMode: 1, insuranceUnits, creatorToken }, 0n);
    expect(ix.keys).toHaveLength(11);
    expect(ix.keys[9].pubkey.equals(insuranceUnits) && ix.keys[10].pubkey.equals(creatorToken)).toBe(true);
    expect(ix.keys.slice(9).every((m) => m.isWritable && !m.isSigner)).toBe(true);
    expect(() => buildRecoverTerminalInsuranceIx({ ...base, riskMode: 1 }, 0n)).toThrow(/FIRST_LOSS/);
  });
  it("FEE_ONLY: creator at [9], no units", () => {
    const creatorToken = k();
    expect(buildRecoverTerminalInsuranceIx({ ...base, riskMode: 2, creatorToken }, 0n).keys[9].pubkey.equals(creatorToken)).toBe(true);
    expect(() => buildRecoverTerminalInsuranceIx({ ...base, riskMode: 2 }, 0n)).toThrow(/creatorToken/);
  });
  it("planStakeWindDown derives units + creator ATA per mode and refuses a missing riskMode", () => {
    const market = syntheticMarket(LAYOUT_V22, 1, { insurance: 5_000n });
    const L = LAYOUT_V22;
    market[L.marketGroupOff + L.group.mode] = 1; // Resolved
    const a = { stakeProgram: k(), wrapperProgram: k(), caller: k(), admin: k(), pool: k(), poolVault: k(), vaultAuth: k(), market: k(), marketData: market, wrapperVault: k(), poolDestToken: k(), collateralMint: k(), closePortfolioIxs: [] };
    const creator = getAssociatedTokenAddressSync(a.collateralMint, a.admin, true);
    const fl = planStakeWindDown({ ...a, riskMode: 1 });
    const ix = (fl.find((s) => s.step === "recoverTerminalBookOnly") as { ix: { keys: { pubkey: PublicKey }[] } }).ix;
    expect(ix.keys).toHaveLength(11);
    expect(ix.keys[9].pubkey.equals(deriveInsuranceUnitsV22(a.wrapperProgram, a.market)[0])).toBe(true);
    expect(ix.keys[10].pubkey.equals(creator)).toBe(true);
    const fo = (planStakeWindDown({ ...a, riskMode: 2 }).find((s) => s.step === "recoverTerminalBookOnly") as { ix: { keys: { pubkey: PublicKey }[] } }).ix;
    expect(fo.keys).toHaveLength(10);
    expect(fo.keys[9].pubkey.equals(creator)).toBe(true);
    expect(() => planStakeWindDown(a as unknown as Parameters<typeof planStakeWindDown>[0])).toThrow(/riskMode/);
  });
});

// E2E-A FCAFL numbers (2026-10-17): liquid 10.96M, deployed 5.48M after the loss, 20M LP supply, redeem 16.44M, 10M LP paid 8.22M.
function poolBytes(): Uint8Array {
  const d = new Uint8Array(STAKE_POOL_SIZE_V5);
  const v = new DataView(d.buffer);
  const F = STAKE_POOL_FIELD_OFF_V5;
  d.set([0x53, 0x50, 0x4f, 0x4f, 0x4c, 0x5f, 0x56, 0x31], F.reserved);
  d[F.version] = 5;
  d[F.riskMode] = STAKE_RISK_MODE.FirstLoss;
  v.setBigUint64(168, 21_920_000n, true); // deposited
  v.setBigUint64(200, 10_960_000n, true); // flushed
  v.setBigUint64(176, 20_000_000n, true); // total lp supply
  for (const off of [F.slab, 40, 72, 104, F.vault, F.percolatorProgram]) d.set(k().toBytes(), off);
  return d;
}
function unitsBytes(stake: bigint, total: bigint, free: bigint): Uint8Array {
  const d = new Uint8Array(16 + 192);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V22.version, true);
  d[10] = ACCOUNT_KIND.InsuranceUnits;
  const b = 16, F = INSURANCE_UNITS_FIELD_OFF_V22;
  d.set(k().toBytes(), b + F.marketGroup);
  const u128 = (o: number, x: bigint) => { v.setBigUint64(b + o, x & ((1n << 64n) - 1n), true); v.setBigUint64(b + o + 8, x >> 64n, true); };
  u128(F.unitsTotal, total); u128(F.unitsStake, stake); u128(F.unitsCreator, total - stake);
  u128(F.snapInsuranceMintAtoms, free); u128(F.snapInsuranceFreeAtoms, free);
  d[b + F.version] = 1;
  return d;
}

describe("stakeWithdrawCapView (stake processor.rs:1626-1631, LiquidityBufferExhausted 36)", () => {
  const units = unitsBytes(10_960_000n, 65_280_000n, 32_640_000n); // deployed = 5.48M
  it("after a loss the cap binds: max now = liquid, the rest deferred; the full balance is refused calmly", () => {
    const cap = stakeWithdrawCapView(poolBytes(), units, 10_960_000n, 20_000_000n)!;
    expect(cap.capBinds).toBe(true);
    expect(cap.maxAtoms).toBe(10_960_000n);
    expect(cap.deferredAtoms).toBeGreaterThan(0n);
    expect(cap.maxLpRaw).toBeLessThan(20_000_000n);
    expect(cap.maxLpRaw >= 10_000_000n).toBe(true); // the recorded 10M LP partial (paid 8.22M) fits
    expect(withdrawAmountError("20", 20_000_000n, 6, cap.maxLpRaw, V22_COPY.stake.withdrawOverCap)).toBe(V22_COPY.stake.withdrawOverCap);
    expect(withdrawAmountError("10", 20_000_000n, 6, cap.maxLpRaw)).toBeNull();
    expect(V22_COPY.stake.withdrawCap("$10.96")).toBe("Part of this pool is deployed as insurance; up to $10.96 can be withdrawn now, the rest returns if and when it's recovered.");
  });
  it("AUD-FC-B3: a stale-high units snapshot is clamped to the live free reading (never quotes above it); live above the snapshot changes nothing", () => {
    const stale = unitsBytes(10_960_000n, 65_280_000n, 65_280_000n); // snapshot says insurance is still full
    const old = stakeWithdrawCapView(poolBytes(), stale, 10_960_000n, 20_000_000n)!;
    const live = stakeWithdrawCapView(poolBytes(), stale, 10_960_000n, 20_000_000n, 32_640_000n)!;
    expect(live.deferredAtoms).toBeLessThan(old.deferredAtoms); // the stale snapshot overstated what the deployed part is worth
    expect(live.maxAtoms).toBeLessThanOrEqual(old.maxAtoms);
    const above = stakeWithdrawCapView(poolBytes(), units, 10_960_000n, 20_000_000n, 999_000_000n)!;
    expect(above).toEqual(stakeWithdrawCapView(poolBytes(), units, 10_960_000n, 20_000_000n)!);
    expect(liveFreeInsuranceAtoms(null)).toBeNull();
    expect(liveFreeInsuranceAtoms(new Uint8Array(10))).toBeNull();
  });
  it("no cap known (units unreadable, vault unread, fee-only) -> null, balance rules apply", () => {
    expect(stakeWithdrawCapView(poolBytes(), null, 10_960_000n, 1n)).toBeNull();
    expect(stakeWithdrawCapView(poolBytes(), units, null, 1n)).toBeNull();
    const fee = poolBytes(); fee[STAKE_POOL_FIELD_OFF_V5.riskMode] = STAKE_RISK_MODE.FeeOnly;
    expect(stakeWithdrawCapView(fee, units, 1n, 1n)).toBeNull();
    expect(withdrawAmountError("30", 20_000_000n, 6)).toBe("Exceeds your staked balance.");
  });
});

import fs from "node:fs";
import path from "node:path";
describe("stake page: withdraw-available button and copy", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../../app/stake/page.tsx"), "utf8");
  it("copy does not promise the recovery", () => {
    expect(V22_COPY.stake.withdrawCap("$1.00")).toContain("if and when it's recovered");
    expect(V22_COPY.stake.withdrawCap("$1.00")).not.toMatch(/returns when/);
  });
  it("a zero cap (nothing liquid) gives maxLpRaw 0 and the card button is disabled and guarded", () => {
    const cap = stakeWithdrawCapView(poolBytes(), unitsBytes(10_960_000n, 65_280_000n, 32_640_000n), 0n, 20_000_000n)!;
    expect(cap.capBinds).toBe(true);
    expect(cap.maxLpRaw).toBe(0n);
    expect(src).toMatch(/disabled=\{!position\.cooldownElapsed \|\| withdrawLoading \|\| withdrawMaxLpRaw\(position\) <= 0n\}/);
    expect(src).toContain("if (withdrawMaxLpRaw(position) <= 0n) return;");
  });
});
