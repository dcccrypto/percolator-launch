import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { MAX_BACKING_BUCKET_EXPIRY_SLOT } from "@percolatorct/sdk";
import {
  DIRECT_BACKING_TOPUP_EXPIRY_SLOT,
  freshLaunchAuthorityEpoch,
  isOracleDelegationApplied,
  oracleAuthorityMismatch,
  ORACLE_MODE_AUTH_MARK,
  sequentialStepKind,
  strayOracleAuthorityMessage,
} from "@/lib/create-market-v18";

// The wrapper's LP-vault sentinel (percolator-prog v16_program.rs:560,
// `LP_VAULT_BACKING_EXPIRY_SLOT: u64 = u64::MAX / 2`). handle_top_up_backing_bucket
// refuses exactly this value with InvalidInstruction (Custom 9).
const LP_VAULT_BACKING_EXPIRY_SLOT = (2n ** 64n - 1n) / 2n;

describe("DIRECT_BACKING_TOPUP_EXPIRY_SLOT", () => {
  it("is not the reserved LP-vault sentinel the wrapper refuses on a direct top-up", () => {
    // The SDK constant the wizard used IS the sentinel — that is the bug.
    expect(MAX_BACKING_BUCKET_EXPIRY_SLOT).toBe(LP_VAULT_BACKING_EXPIRY_SLOT);
    expect(DIRECT_BACKING_TOPUP_EXPIRY_SLOT).not.toBe(LP_VAULT_BACKING_EXPIRY_SLOT);
  });

  it("still never lapses in practice (same magnitude as the sentinel, matches the reseed script)", () => {
    // newmarkets.ts BORN_IMMORTAL_BACKING_EXPIRY = MAX_BACKING_BUCKET_EXPIRY_SLOT - 1n
    expect(DIRECT_BACKING_TOPUP_EXPIRY_SLOT).toBe(MAX_BACKING_BUCKET_EXPIRY_SLOT - 1n);
    expect(DIRECT_BACKING_TOPUP_EXPIRY_SLOT > 10n ** 18n).toBe(true);
  });
});

describe("freshLaunchAuthorityEpoch", () => {
  it("is 1 once the keeper hand-off (UpdateAssetAuthority, +1) is in the batch", () => {
    // Measured on market 5T1yvE… after M1 + co-sign + M2: authorityEpoch = 1.
    expect(freshLaunchAuthorityEpoch(true)).toBe(1n);
  });

  it("is 0 when nothing in the batch advances the lane (admin / pyth launch)", () => {
    expect(freshLaunchAuthorityEpoch(false)).toBe(0n);
  });
});

describe("isOracleDelegationApplied", () => {
  const deployer = Keypair.generate().publicKey;
  const keeper = Keypair.generate().publicKey;

  it("is true after the hand-off: AUTH_MARK mode and the deployer no longer holds the authority", () => {
    // The stuck market's live profile: oracleMode 3, oracleAuthority = keeper FbTbDe….
    expect(isOracleDelegationApplied({ oracleMode: ORACLE_MODE_AUTH_MARK, oracleAuthority: keeper }, deployer)).toBe(true);
  });

  it("is false before the hand-off: the deployer is still the oracle authority", () => {
    expect(isOracleDelegationApplied({ oracleMode: 0, oracleAuthority: deployer }, deployer)).toBe(false);
  });

  it("is false when AUTH_MARK is configured but the authority was never moved", () => {
    expect(isOracleDelegationApplied({ oracleMode: ORACLE_MODE_AUTH_MARK, oracleAuthority: deployer }, deployer)).toBe(false);
  });

  it("is false for a non-AUTH_MARK market even if someone else holds the authority", () => {
    expect(isOracleDelegationApplied({ oracleMode: 0, oracleAuthority: keeper }, deployer)).toBe(false);
  });

  // The live failure: devnet markets 4beVPGLp… and ELaepc4x… hold oracle
  // authority HQuGYrSg… while the keeper that cranks every working market is
  // FbTbDeGW…. Both were reported as a finished hand-off.
  const strayKey = Keypair.generate().publicKey;

  it("is FALSE when a third key holds the authority and the keeper is known", () => {
    expect(
      isOracleDelegationApplied({ oracleMode: ORACLE_MODE_AUTH_MARK, oracleAuthority: strayKey }, deployer, keeper),
    ).toBe(false);
  });

  it("is true when the authority is the known keeper", () => {
    expect(
      isOracleDelegationApplied({ oracleMode: ORACLE_MODE_AUTH_MARK, oracleAuthority: keeper }, deployer, keeper),
    ).toBe(true);
  });

  it("keeps GH#2680 behaviour when the keeper is unknown (backend unreachable)", () => {
    // Must still skip a hand-off that landed, or a resume re-sends it into Custom(8).
    expect(
      isOracleDelegationApplied({ oracleMode: ORACLE_MODE_AUTH_MARK, oracleAuthority: keeper }, deployer, null),
    ).toBe(true);
    expect(
      isOracleDelegationApplied({ oracleMode: ORACLE_MODE_AUTH_MARK, oracleAuthority: deployer }, deployer, null),
    ).toBe(false);
  });
});

describe("oracleAuthorityMismatch", () => {
  const deployer = Keypair.generate().publicKey;
  const keeper = Keypair.generate().publicKey;
  const strayKey = Keypair.generate().publicKey;

  it("reports the stray authority that makes a market unpriceable", () => {
    expect(
      oracleAuthorityMismatch({ oracleMode: ORACLE_MODE_AUTH_MARK, oracleAuthority: strayKey }, deployer, keeper),
    ).toBe(strayKey);
  });

  it("is null when the keeper holds it", () => {
    expect(
      oracleAuthorityMismatch({ oracleMode: ORACLE_MODE_AUTH_MARK, oracleAuthority: keeper }, deployer, keeper),
    ).toBeNull();
  });

  it("is null when the hand-off simply has not run yet (deployer still holds it)", () => {
    expect(
      oracleAuthorityMismatch({ oracleMode: ORACLE_MODE_AUTH_MARK, oracleAuthority: deployer }, deployer, keeper),
    ).toBeNull();
  });

  it("is null when the keeper is unknown — never block a launch on a missing GET", () => {
    expect(
      oracleAuthorityMismatch({ oracleMode: ORACLE_MODE_AUTH_MARK, oracleAuthority: strayKey }, deployer, null),
    ).toBeNull();
  });

  it("is null for a non-AUTH_MARK market", () => {
    expect(oracleAuthorityMismatch({ oracleMode: 0, oracleAuthority: strayKey }, deployer, keeper)).toBeNull();
  });
});

describe("sequentialStepKind", () => {
  it("maps the wizard's six sequential steps", () => {
    expect([0, 1, 2, 3, 4, 5].map(sequentialStepKind)).toEqual([
      "create-market",
      "oracle-delegation",
      "lp-init",
      "funding",
      "earn-vault",
      "stake-pool",
    ]);
  });

  it("clamps out-of-range steps", () => {
    expect(sequentialStepKind(-1)).toBe("create-market");
    expect(sequentialStepKind(9)).toBe("stake-pool");
  });
});

describe("strayOracleAuthorityMessage", () => {
  const stray = Keypair.generate().publicKey;
  const keeper = Keypair.generate().publicKey;

  it("names both keys, says nothing further was sent and what to do", () => {
    const m = strayOracleAuthorityMessage(stray, keeper);
    expect(m).toContain(stray.toBase58());
    expect(m).toContain(keeper.toBase58());
    expect(m).toMatch(/nothing further was sent/);
    expect(m).toMatch(/report it to the team/);
  });
});
