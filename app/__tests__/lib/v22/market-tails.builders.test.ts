// @vitest-environment node
/**
 * Every REAL app builder for the tail-taking tags, checked against the SDK tail indices (BOND_TAIL_INDEX_V22 /
 * INSURANCE_UNITS_TAIL_FROM_V22): the tails append cleanly, or a mismatch is a LOUD error in development / test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { ACCOUNTS_TOPUP_INSURANCE, buildAccountMetas, encodeTopUpInsurance } from "@percolatorct/sdk";
import { TransactionInstruction } from "@solana/web3.js";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { ACCOUNT_KIND, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC, deriveBondTrancheV22, deriveInsuranceUnitsV22 } from "@/lib/v22/sdk";
import { MarketTailMismatchError, __setTailsClockForTest, applyMarketTailsV22, withMarketTailsV22 } from "@/lib/v22/market-tails";
import { buildLpVaultCrankFeesIx, buildVaultLpReleaseSurplusIx, buildWithdrawJuniorTrancheIx, type VaultLpMarket } from "@/lib/limits/p3-ix";
import { buildVaultLpAllocateIx } from "@/lib/v21/sdk/p2b-earn";
import { buildLpCrankIx } from "@/lib/pre-resolve";

const k = () => Keypair.generate().publicKey;
const prog = k();
const market = k();
const tranche = deriveBondTrancheV22(prog, market)[0];
const units = deriveInsuranceUnitsV22(prog, market)[0];
const tails = { bondTranche: tranche, insuranceUnits: units };
const m: VaultLpMarket = { programId: prog, market, registry: k(), vaultLpState: k(), lpPortfolio: k(), ledger: k(), siblingLedger: k(), ext: k() };

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => __setDevnetV22ForTest(null));

const lastIs = (ix: TransactionInstruction, pk: PublicKey) => ix.keys.at(-1)!.pubkey.equals(pk);

describe("builders that match the SDK tail index", () => {
  it("78 with the vault ext + LP portfolio (9 accounts): tranche appended, writable, LP writable", () => {
    const ix = buildLpVaultCrankFeesIx({ programId: prog, cranker: k(), market, registry: m.registry, ledger: m.ledger, siblingLedger: m.siblingLedger, domain: 0, bound: { vaultLpState: m.vaultLpState, ext: m.ext, lpPortfolio: m.lpPortfolio } });
    expect(ix.keys).toHaveLength(9);
    expect(ix.keys[1].pubkey.equals(market)).toBe(true);
    const out = applyMarketTailsV22(ix, tails);
    expect(lastIs(out, tranche)).toBe(true);
    expect(out.keys[8].isWritable).toBe(true);
  });
  it("97 with the ext at [11] (12 accounts): tranche appended", () => {
    const ix = buildWithdrawJuniorTrancheIx(m, k(), k(), k(), k(), 1n);
    expect(ix.keys).toHaveLength(12);
    expect(ix.keys[1].pubkey.equals(market)).toBe(true);
    expect(lastIs(applyMarketTailsV22(ix, tails), tranche)).toBe(true);
  });
  it("102 resolved (11 accounts): tranche appended; live (7): left alone, no error", () => {
    const resolved = buildVaultLpReleaseSurplusIx(m, k(), 1n, 0, { destToken: k(), vaultToken: k(), vaultAuthority: k() });
    expect(resolved.keys).toHaveLength(11);
    expect(lastIs(applyMarketTailsV22(resolved, tails), tranche)).toBe(true);
    const live = buildVaultLpReleaseSurplusIx(m, k(), 1n, 0, null);
    expect(live.keys).toHaveLength(7);
    expect(applyMarketTailsV22(live, tails)).toBe(live);
  });
  it("103 allocate (9 accounts): tranche appended", () => {
    const ix = buildVaultLpAllocateIx({ programId: prog, cranker: k(), market, registry: m.registry, vaultLpState: m.vaultLpState, lpPortfolio: m.lpPortfolio, ledger: m.ledger, siblingLedger: m.siblingLedger });
    expect(ix.keys).toHaveLength(9);
    expect(lastIs(applyMarketTailsV22(ix, tails), tranche)).toBe(true);
  });
  it("9 TopUpInsurance (5 accounts, market at [1]): units appended last", () => {
    const keys = buildAccountMetas(ACCOUNTS_TOPUP_INSURANCE, [k(), market, k(), k(), SystemProgram.programId]);
    const ix = new TransactionInstruction({ programId: prog, keys, data: Buffer.from(encodeTopUpInsurance({ marketId: 1n, intentId: 1n, authorityEpoch: 1n, amount: "1" })) });
    expect(ix.data[0]).toBe(9);
    expect(ix.keys[1].pubkey.equals(market)).toBe(true);
    expect(lastIs(applyMarketTailsV22(ix, tails), units)).toBe(true);
  });
});

describe("a builder that does NOT match is loud in development (negative controls)", () => {
  it("pre-resolve's tag 78 (bound, 7 accounts, no vault ext / LP portfolio) cannot take the bond tail", () => {
    const ix = buildLpCrankIx(prog, k(), market, 0, true);
    expect(ix.data[0]).toBe(78);
    expect(ix.keys).toHaveLength(7);
    expect(() => applyMarketTailsV22(ix, tails)).toThrow(MarketTailMismatchError);
  });
  it("a 97 without the ext (11 accounts) is loud too, and production keeps the quiet visible-refusal behaviour", () => {
    const noExt = buildWithdrawJuniorTrancheIx({ ...m, ext: undefined }, k(), k(), k(), k(), 1n);
    expect(noExt.keys).toHaveLength(11);
    expect(() => applyMarketTailsV22(noExt, tails)).toThrow(MarketTailMismatchError);
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      expect(applyMarketTailsV22(noExt, tails)).toBe(noExt);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev ?? "development";
    }
  });
  it("withMarketTailsV22 propagates the loud error when the tranche exists (not swallowed by the per-instruction catch)", async () => {
    const bad = buildLpCrankIx(prog, k(), market, 0, true);
    const d = new Uint8Array(200);
    new DataView(d.buffer).setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
    new DataView(d.buffer).setUint16(8, LAYOUT_V22.version, true);
    d[10] = ACCOUNT_KIND.BondTranche;
    const conn = { getMultipleAccountsInfo: async () => [{ owner: prog, data: d, lamports: 1, executable: false }, null] };
    __setTailsClockForTest(null);
    await expect(withMarketTailsV22(conn as never, prog, [bad])).rejects.toThrow(MarketTailMismatchError);
    // no tranche on chain: nothing to mismatch against, instruction passes through
    __setTailsClockForTest(null);
    await expect(withMarketTailsV22({ getMultipleAccountsInfo: async () => [null, null] } as never, prog, [bad])).resolves.toEqual([bad]);
  });
});
