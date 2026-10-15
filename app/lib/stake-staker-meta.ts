import type { AccountMeta } from "@solana/web3.js";

/**
 * percolator-stake (live v2.2 0f88ff1) debits the staker in Deposit / DepositJunior: it pays the
 * per-user deposit PDA rent (`create_or_adopt_pda(deposit_pda, user, ..)`) and, on FIRST_LOSS pools,
 * the wrapper tag-116 refresh CPI. So account [0] must be signer AND writable. @percolatorct/sdk 8.0.0's
 * `depositAccounts` marks it read-only, which only works when the staker is also the fee payer
 * (QA 2026-10-15: PrivilegeEscalation otherwise). Fixed upstream in percolator-sdk 96b267e / a18c199.
 */
export function withWritableStaker(keys: AccountMeta[]): AccountMeta[] {
  if (keys.length === 0) return keys;
  return [{ ...keys[0], isSigner: true, isWritable: true }, ...keys.slice(1)];
}
