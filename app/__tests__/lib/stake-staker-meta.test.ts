import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { depositAccounts } from "@percolatorct/sdk";
import { withWritableStaker } from "@/lib/stake-staker-meta";
import { ACCOUNTS_STAKE_DEPOSIT_V5, ACCOUNTS_STAKE_WITHDRAW_V5 } from "@/lib/v22/sdk/v22-stake";

// QA 2026-10-15: a staker who is not the fee payer failed with PrivilegeEscalation because the
// staker was read-only. percolator-stake 0f88ff1 debits the staker (deposit PDA rent, FIRST_LOSS
// tag-116 refresh CPI), so account [0] must be signer + writable (SDK fix 96b267e / a18c199).
describe("stake staker account is signer + writable", () => {
  it("v5 first-loss deposit / withdraw specs", () => {
    expect(ACCOUNTS_STAKE_DEPOSIT_V5[0]).toMatchObject({ name: "user", signer: true, writable: true });
    expect(ACCOUNTS_STAKE_WITHDRAW_V5[0]).toMatchObject({ name: "user", signer: true, writable: true });
  });
  it("legacy depositAccounts (sdk 8.0.0) is hardened by withWritableStaker", () => {
    const k = () => Keypair.generate().publicKey;
    const user = k();
    const keys = withWritableStaker(
      depositAccounts({ user, pool: k(), userCollateralAta: k(), vault: k(), lpMint: k(), userLpAta: k(), vaultAuth: k(), depositPda: k(), slab: k() } as never),
    );
    expect(keys[0].pubkey.equals(user)).toBe(true);
    expect(keys[0].isSigner).toBe(true);
    expect(keys[0].isWritable).toBe(true);
  });
  it("leaves the other metas untouched", () => {
    const k = () => Keypair.generate().publicKey;
    const raw = [
      { pubkey: k(), isSigner: true, isWritable: false },
      { pubkey: k(), isSigner: false, isWritable: true },
    ];
    const out = withWritableStaker(raw);
    expect(out[1]).toBe(raw[1]);
    expect(raw[0].isWritable).toBe(false);
  });
});
