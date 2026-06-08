/**
 * GH#2014 — upgrade authority classification guards.
 * https://github.com/dcccrypto/percolator-launch/issues/2014
 */

import { describe, it, expect } from "vitest";
import bs58 from "bs58";
import {
  assessUpgradeAuthority,
  classifyUpgradeAuthority,
  DEVNET_EOA_UPGRADE_AUTHORITY,
  MAINNET_EOA_UPGRADE_AUTHORITY,
  MAINNET_PROGRAM_ID,
  parseUpgradeAuthorityBase58,
  SQUADS_V4_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from "@/lib/upgrade-authority";

describe("classifyUpgradeAuthority", () => {
  it("flags documented mainnet EOA as known_eoa", () => {
    expect(
      classifyUpgradeAuthority(MAINNET_EOA_UPGRADE_AUTHORITY, SYSTEM_PROGRAM_ID),
    ).toBe("known_eoa");
  });

  it("treats Squads vault owner as squads_multisig", () => {
    expect(
      classifyUpgradeAuthority("SomeVaultPDA1111111111111111111111111111", SQUADS_V4_PROGRAM_ID),
    ).toBe("squads_multisig");
  });

  it("treats null authority as immutable", () => {
    expect(classifyUpgradeAuthority(null, null)).toBe("immutable");
  });
});

describe("assessUpgradeAuthority", () => {
  it("marks known EOA as unsafe with remediation hint", () => {
    const result = assessUpgradeAuthority({
      programId: MAINNET_PROGRAM_ID,
      authority: MAINNET_EOA_UPGRADE_AUTHORITY,
      authorityOwner: SYSTEM_PROGRAM_ID,
    });
    expect(result.safe).toBe(false);
    expect(result.kind).toBe("known_eoa");
    expect(result.message).toContain("Squads");
  });

  it("marks Squads vault as safe", () => {
    const result = assessUpgradeAuthority({
      programId: MAINNET_PROGRAM_ID,
      authority: "Vault1111111111111111111111111111111111",
      authorityOwner: SQUADS_V4_PROGRAM_ID,
    });
    expect(result.safe).toBe(true);
    expect(result.kind).toBe("squads_multisig");
  });
});

describe("parseUpgradeAuthorityBase58", () => {
  it("reads authority pubkey at offset 13 when option tag is 1", () => {
    const data = new Uint8Array(45);
    data[12] = 1;
    data.set(bs58.decode(DEVNET_EOA_UPGRADE_AUTHORITY), 13);
    expect(parseUpgradeAuthorityBase58(data)).toBe(DEVNET_EOA_UPGRADE_AUTHORITY);
  });

  it("returns null when upgrade authority option is none", () => {
    const data = new Uint8Array(45);
    data[12] = 0;
    expect(parseUpgradeAuthorityBase58(data)).toBeNull();
  });
});
