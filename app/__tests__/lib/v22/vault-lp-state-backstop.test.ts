// @vitest-environment node
/**
 * Audit 2026-10-17 (S3-D1a): bytes [232, 240) of a VaultLpStateV18 account are NOT padding on the deployed wrapper
 * (percolator-prog aca02ba6 `state::VaultLpStateV18`, v16_program.rs `backstop_outstanding_atoms: u64 // 216..224` of the
 * body = account bytes 232..240): they hold the G9 insurance the backstop (tag 111) lent to the vault LP. The program's
 * `validate_vault_lp_state` does not require them to be zero. The vendored decoder refused any non-zero value
 * ("the program would reject it too") and did not expose the amount, so the moment a backstop is outstanding the v2.2 vault
 * state became unreadable.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { ACCOUNT_KIND, LAYOUT_V22, WRAPPER_ACCOUNT_MAGIC } from "@/lib/v22/sdk";
import { decodeVaultLpStateP3, VAULT_LP_STATE_OFF_P3 } from "@/lib/v22/sdk/records/p3-vault-lp";

function vaultLpState(backstop: bigint): Uint8Array {
  const d = new Uint8Array(16 + 256);
  const v = new DataView(d.buffer);
  v.setBigUint64(0, WRAPPER_ACCOUNT_MAGIC, true);
  v.setUint16(8, LAYOUT_V22.version, true);
  d[10] = ACCOUNT_KIND.VaultLpState;
  for (const o of [16, 48, 80, 112]) d.set(Keypair.generate().publicKey.toBytes(), o);
  v.setBigUint64(16 + 128, 1_000_000n, true); // senior_claim_atoms
  v.setUint16(16 + 210, 2_000, true); // junior_floor_bps
  v.setUint16(16 + 212, 10_000, true); // senior_fee_share_bps
  d[16 + 214] = 1; // version
  v.setBigUint64(16 + 216, backstop, true); // backstop_outstanding_atoms (u64)
  v.setBigUint64(16 + 240, 7n, true); // senior_draw_outstanding_atoms (low word)
  return d;
}

describe("VaultLpStateV18 backstop_outstanding_atoms (account bytes 232..240)", () => {
  it("decodes a state with no backstop (unchanged behaviour)", () => {
    const st = decodeVaultLpStateP3(vaultLpState(0n));
    expect(st.seniorClaimAtoms).toBe(1_000_000n);
    expect(st.backstopOutstandingAtoms).toBe(0n);
  });
  it("decodes (does not refuse) a state with an outstanding backstop, and exposes it", () => {
    const st = decodeVaultLpStateP3(vaultLpState(123_456_789n));
    expect(st.backstopOutstandingAtoms).toBe(123_456_789n);
    expect(st.seniorDrawOutstandingAtoms).toBe(7n);
  });
  it("the field table names the real field at the real offset", () => {
    expect(VAULT_LP_STATE_OFF_P3.backstopOutstandingAtoms).toBe(232);
    expect("padding" in VAULT_LP_STATE_OFF_P3).toBe(false);
  });
  it("still refuses what the program refuses (version, floor, fee share)", () => {
    const bad = vaultLpState(0n);
    bad[16 + 214] = 2;
    expect(() => decodeVaultLpStateP3(bad)).toThrow(/invalid/);
  });
});
