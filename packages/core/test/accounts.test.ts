import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  ACCOUNTS_INIT_MARKET,
  ACCOUNTS_INIT_USER,
  ACCOUNTS_INIT_LP,
  ACCOUNTS_DEPOSIT_COLLATERAL,
  ACCOUNTS_WITHDRAW_COLLATERAL,
  ACCOUNTS_KEEPER_CRANK,
  ACCOUNTS_TRADE_NOCPI,
  ACCOUNTS_LIQUIDATE_AT_ORACLE,
  ACCOUNTS_CLOSE_ACCOUNT,
  ACCOUNTS_TOPUP_INSURANCE,
  ACCOUNTS_TRADE_CPI,
  ACCOUNTS_SET_RISK_THRESHOLD,
  ACCOUNTS_UPDATE_ADMIN,
  ACCOUNTS_CLOSE_SLAB,
  ACCOUNTS_UPDATE_CONFIG,
  ACCOUNTS_SET_MAINTENANCE_FEE,
  ACCOUNTS_SET_ORACLE_AUTHORITY,
  ACCOUNTS_PUSH_ORACLE_PRICE,
  ACCOUNTS_RESOLVE_MARKET,
  ACCOUNTS_WITHDRAW_INSURANCE,
  ACCOUNTS_INIT_VAMM,
  ACCOUNTS_PAUSE_MARKET,
  ACCOUNTS_UNPAUSE_MARKET,
  ACCOUNTS_CREATE_INSURANCE_MINT,
  ACCOUNTS_DEPOSIT_INSURANCE_LP,
  ACCOUNTS_WITHDRAW_INSURANCE_LP,
  buildAccountMetas,
  WELL_KNOWN,
  type AccountSpec,
} from "../src/abi/accounts.js";

// ============================================================================
// Helper
// ============================================================================
function makeKeys(n: number): PublicKey[] {
  return Array.from({ length: n }, () => PublicKey.unique());
}

// ============================================================================
// Account spec structure tests
// ============================================================================

describe("Account orderings", () => {
  const allSpecs: [string, readonly AccountSpec[]][] = [
    ["ACCOUNTS_INIT_MARKET", ACCOUNTS_INIT_MARKET],
    ["ACCOUNTS_INIT_USER", ACCOUNTS_INIT_USER],
    ["ACCOUNTS_INIT_LP", ACCOUNTS_INIT_LP],
    ["ACCOUNTS_DEPOSIT_COLLATERAL", ACCOUNTS_DEPOSIT_COLLATERAL],
    ["ACCOUNTS_WITHDRAW_COLLATERAL", ACCOUNTS_WITHDRAW_COLLATERAL],
    ["ACCOUNTS_KEEPER_CRANK", ACCOUNTS_KEEPER_CRANK],
    ["ACCOUNTS_TRADE_NOCPI", ACCOUNTS_TRADE_NOCPI],
    ["ACCOUNTS_LIQUIDATE_AT_ORACLE", ACCOUNTS_LIQUIDATE_AT_ORACLE],
    ["ACCOUNTS_CLOSE_ACCOUNT", ACCOUNTS_CLOSE_ACCOUNT],
    ["ACCOUNTS_TOPUP_INSURANCE", ACCOUNTS_TOPUP_INSURANCE],
    ["ACCOUNTS_TRADE_CPI", ACCOUNTS_TRADE_CPI],
    ["ACCOUNTS_SET_RISK_THRESHOLD", ACCOUNTS_SET_RISK_THRESHOLD],
    ["ACCOUNTS_UPDATE_ADMIN", ACCOUNTS_UPDATE_ADMIN],
    ["ACCOUNTS_CLOSE_SLAB", ACCOUNTS_CLOSE_SLAB],
    ["ACCOUNTS_UPDATE_CONFIG", ACCOUNTS_UPDATE_CONFIG],
    ["ACCOUNTS_SET_MAINTENANCE_FEE", ACCOUNTS_SET_MAINTENANCE_FEE],
    ["ACCOUNTS_SET_ORACLE_AUTHORITY", ACCOUNTS_SET_ORACLE_AUTHORITY],
    ["ACCOUNTS_PUSH_ORACLE_PRICE", ACCOUNTS_PUSH_ORACLE_PRICE],
    ["ACCOUNTS_RESOLVE_MARKET", ACCOUNTS_RESOLVE_MARKET],
    ["ACCOUNTS_WITHDRAW_INSURANCE", ACCOUNTS_WITHDRAW_INSURANCE],
    ["ACCOUNTS_INIT_VAMM", ACCOUNTS_INIT_VAMM],
    ["ACCOUNTS_PAUSE_MARKET", ACCOUNTS_PAUSE_MARKET],
    ["ACCOUNTS_UNPAUSE_MARKET", ACCOUNTS_UNPAUSE_MARKET],
    ["ACCOUNTS_CREATE_INSURANCE_MINT", ACCOUNTS_CREATE_INSURANCE_MINT],
    ["ACCOUNTS_DEPOSIT_INSURANCE_LP", ACCOUNTS_DEPOSIT_INSURANCE_LP],
    ["ACCOUNTS_WITHDRAW_INSURANCE_LP", ACCOUNTS_WITHDRAW_INSURANCE_LP],
  ];

  it.each(allSpecs)("%s has valid structure", (_name, spec) => {
    expect(spec.length).toBeGreaterThan(0);
    for (const account of spec) {
      expect(account).toHaveProperty("name");
      expect(account).toHaveProperty("signer");
      expect(account).toHaveProperty("writable");
      expect(typeof account.name).toBe("string");
      expect(typeof account.signer).toBe("boolean");
      expect(typeof account.writable).toBe("boolean");
    }
  });

  it.each(allSpecs)("%s has unique account names", (_name, spec) => {
    const names = spec.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // Verify expected account counts match Rust processor
  it("ACCOUNTS_INIT_MARKET has 9 accounts", () => {
    expect(ACCOUNTS_INIT_MARKET).toHaveLength(9);
  });

  it("ACCOUNTS_INIT_USER has 5 accounts", () => {
    expect(ACCOUNTS_INIT_USER).toHaveLength(5);
  });

  it("ACCOUNTS_INIT_LP has 5 accounts", () => {
    expect(ACCOUNTS_INIT_LP).toHaveLength(5);
  });

  it("ACCOUNTS_DEPOSIT_COLLATERAL has 6 accounts", () => {
    expect(ACCOUNTS_DEPOSIT_COLLATERAL).toHaveLength(6);
  });

  it("ACCOUNTS_WITHDRAW_COLLATERAL has 8 accounts", () => {
    expect(ACCOUNTS_WITHDRAW_COLLATERAL).toHaveLength(8);
  });

  it("ACCOUNTS_KEEPER_CRANK has 4 accounts", () => {
    expect(ACCOUNTS_KEEPER_CRANK).toHaveLength(4);
  });

  it("ACCOUNTS_TRADE_NOCPI has 5 accounts", () => {
    expect(ACCOUNTS_TRADE_NOCPI).toHaveLength(5);
  });

  it("ACCOUNTS_LIQUIDATE_AT_ORACLE has 4 accounts", () => {
    expect(ACCOUNTS_LIQUIDATE_AT_ORACLE).toHaveLength(4);
  });

  it("ACCOUNTS_CLOSE_ACCOUNT has 8 accounts", () => {
    expect(ACCOUNTS_CLOSE_ACCOUNT).toHaveLength(8);
  });

  it("ACCOUNTS_TOPUP_INSURANCE has 5 accounts", () => {
    expect(ACCOUNTS_TOPUP_INSURANCE).toHaveLength(5);
  });

  it("ACCOUNTS_TRADE_CPI has 8 accounts", () => {
    expect(ACCOUNTS_TRADE_CPI).toHaveLength(8);
  });

  it("ACCOUNTS_SET_RISK_THRESHOLD has 2 accounts", () => {
    expect(ACCOUNTS_SET_RISK_THRESHOLD).toHaveLength(2);
  });

  it("ACCOUNTS_WITHDRAW_INSURANCE has 6 accounts", () => {
    expect(ACCOUNTS_WITHDRAW_INSURANCE).toHaveLength(6);
  });

  it("ACCOUNTS_CREATE_INSURANCE_MINT has 9 accounts", () => {
    expect(ACCOUNTS_CREATE_INSURANCE_MINT).toHaveLength(9);
  });

  it("ACCOUNTS_DEPOSIT_INSURANCE_LP has 8 accounts", () => {
    expect(ACCOUNTS_DEPOSIT_INSURANCE_LP).toHaveLength(8);
  });

  it("ACCOUNTS_WITHDRAW_INSURANCE_LP has 8 accounts", () => {
    expect(ACCOUNTS_WITHDRAW_INSURANCE_LP).toHaveLength(8);
  });

  it("ACCOUNTS_INIT_VAMM has 4 accounts", () => {
    expect(ACCOUNTS_INIT_VAMM).toHaveLength(4);
  });

  it("ACCOUNTS_PAUSE_MARKET has 2 accounts", () => {
    expect(ACCOUNTS_PAUSE_MARKET).toHaveLength(2);
  });

  it("ACCOUNTS_UNPAUSE_MARKET has 2 accounts", () => {
    expect(ACCOUNTS_UNPAUSE_MARKET).toHaveLength(2);
  });
});

// ============================================================================
// Signer / writable invariants
// ============================================================================

describe("Signer / writable invariants", () => {
  it("InitMarket admin[0] is signer+writable", () => {
    expect(ACCOUNTS_INIT_MARKET[0].name).toBe("admin");
    expect(ACCOUNTS_INIT_MARKET[0].signer).toBe(true);
    expect(ACCOUNTS_INIT_MARKET[0].writable).toBe(true);
  });

  it("InitUser user[0] is signer+writable", () => {
    expect(ACCOUNTS_INIT_USER[0].name).toBe("user");
    expect(ACCOUNTS_INIT_USER[0].signer).toBe(true);
    expect(ACCOUNTS_INIT_USER[0].writable).toBe(true);
  });

  it("TradeNoCpi has two signers (user and lp)", () => {
    const signers = ACCOUNTS_TRADE_NOCPI.filter((a) => a.signer);
    expect(signers).toHaveLength(2);
    expect(signers[0].name).toBe("user");
    expect(signers[1].name).toBe("lp");
  });

  it("TradeCpi has only user as signer (lpOwner is not signer)", () => {
    const signers = ACCOUNTS_TRADE_CPI.filter((a) => a.signer);
    expect(signers).toHaveLength(1);
    expect(signers[0].name).toBe("user");
  });

  it("LiquidateAtOracle account[0] is not signer and not writable (unused)", () => {
    expect(ACCOUNTS_LIQUIDATE_AT_ORACLE[0].name).toBe("unused");
    expect(ACCOUNTS_LIQUIDATE_AT_ORACLE[0].signer).toBe(false);
    expect(ACCOUNTS_LIQUIDATE_AT_ORACLE[0].writable).toBe(false);
  });

  it("slab is writable in all trading/state-changing instructions", () => {
    const stateChanging = [
      ACCOUNTS_INIT_MARKET,
      ACCOUNTS_INIT_USER,
      ACCOUNTS_INIT_LP,
      ACCOUNTS_DEPOSIT_COLLATERAL,
      ACCOUNTS_WITHDRAW_COLLATERAL,
      ACCOUNTS_KEEPER_CRANK,
      ACCOUNTS_TRADE_NOCPI,
      ACCOUNTS_LIQUIDATE_AT_ORACLE,
      ACCOUNTS_CLOSE_ACCOUNT,
      ACCOUNTS_TOPUP_INSURANCE,
      ACCOUNTS_TRADE_CPI,
      ACCOUNTS_SET_RISK_THRESHOLD,
      ACCOUNTS_PAUSE_MARKET,
      ACCOUNTS_UNPAUSE_MARKET,
    ];
    for (const spec of stateChanging) {
      const slab = spec.find((a) => a.name === "slab");
      expect(slab, `slab missing in spec`).toBeDefined();
      expect(slab!.writable).toBe(true);
    }
  });

  it("admin-only instructions require admin/authority as signer", () => {
    const adminInstructions = [
      ACCOUNTS_SET_RISK_THRESHOLD,
      ACCOUNTS_UPDATE_ADMIN,
      ACCOUNTS_CLOSE_SLAB,
      ACCOUNTS_UPDATE_CONFIG,
      ACCOUNTS_SET_MAINTENANCE_FEE,
      ACCOUNTS_SET_ORACLE_AUTHORITY,
      ACCOUNTS_RESOLVE_MARKET,
      ACCOUNTS_PAUSE_MARKET,
      ACCOUNTS_UNPAUSE_MARKET,
    ];
    for (const spec of adminInstructions) {
      expect(spec[0].signer).toBe(true);
    }
  });

  it("CreateInsuranceMint has two signers (admin and payer)", () => {
    const signers = ACCOUNTS_CREATE_INSURANCE_MINT.filter((a) => a.signer);
    expect(signers).toHaveLength(2);
    expect(signers.map((s) => s.name).sort()).toEqual(["admin", "payer"]);
  });
});

// ============================================================================
// buildAccountMetas
// ============================================================================

describe("buildAccountMetas", () => {
  it("builds correct metas for a 2-account spec", () => {
    const keys = makeKeys(2);
    const metas = buildAccountMetas(ACCOUNTS_SET_RISK_THRESHOLD, keys);

    expect(metas).toHaveLength(2);
    expect(metas[0].pubkey.equals(keys[0])).toBe(true);
    expect(metas[0].isSigner).toBe(true);
    expect(metas[0].isWritable).toBe(true);
    expect(metas[1].pubkey.equals(keys[1])).toBe(true);
    expect(metas[1].isSigner).toBe(false);
    expect(metas[1].isWritable).toBe(true);
  });

  it("builds correct metas for InitMarket (9 accounts)", () => {
    const keys = makeKeys(9);
    const metas = buildAccountMetas(ACCOUNTS_INIT_MARKET, keys);

    expect(metas).toHaveLength(9);
    // admin
    expect(metas[0].isSigner).toBe(true);
    expect(metas[0].isWritable).toBe(true);
    // slab
    expect(metas[1].isSigner).toBe(false);
    expect(metas[1].isWritable).toBe(true);
    // mint (read-only)
    expect(metas[2].isSigner).toBe(false);
    expect(metas[2].isWritable).toBe(false);
    // All keys match
    for (let i = 0; i < 9; i++) {
      expect(metas[i].pubkey.equals(keys[i])).toBe(true);
    }
  });

  it("throws on key count mismatch (too few keys)", () => {
    const keys = makeKeys(1);
    expect(() => buildAccountMetas(ACCOUNTS_SET_RISK_THRESHOLD, keys)).toThrow(
      "Account count mismatch: expected 2, got 1"
    );
  });

  it("throws on key count mismatch (too many keys)", () => {
    const keys = makeKeys(10);
    expect(() => buildAccountMetas(ACCOUNTS_INIT_MARKET, keys)).toThrow(
      "Account count mismatch: expected 9, got 10"
    );
  });

  it("handles zero-key spec (empty)", () => {
    const emptySpec: readonly AccountSpec[] = [];
    const metas = buildAccountMetas(emptySpec, []);
    expect(metas).toHaveLength(0);
  });

  it("preserves pubkey identity (not just equals)", () => {
    const key = PublicKey.unique();
    const metas = buildAccountMetas(
      [{ name: "test", signer: false, writable: false }],
      [key]
    );
    expect(metas[0].pubkey).toBe(key);
  });
});

// ============================================================================
// WELL_KNOWN
// ============================================================================

describe("WELL_KNOWN program/sysvar keys", () => {
  it("tokenProgram is SPL Token program ID", () => {
    expect(WELL_KNOWN.tokenProgram.toBase58()).toBe(
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    );
  });

  it("clock is SYSVAR_CLOCK_PUBKEY", () => {
    expect(WELL_KNOWN.clock.toBase58()).toBe(
      "SysvarC1ock11111111111111111111111111111111"
    );
  });

  it("rent is SYSVAR_RENT_PUBKEY", () => {
    expect(WELL_KNOWN.rent.toBase58()).toBe(
      "SysvarRent111111111111111111111111111111111"
    );
  });

  it("systemProgram is SystemProgram.programId", () => {
    expect(WELL_KNOWN.systemProgram.toBase58()).toBe(
      "11111111111111111111111111111111"
    );
  });
});
