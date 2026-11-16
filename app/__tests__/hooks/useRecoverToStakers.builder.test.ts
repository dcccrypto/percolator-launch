// @vitest-environment node
/**
 * buildRecoverIxs with the REAL vendored builder and real PDAs: accounts + data checked against @percolatorct/sdk 8.0.0
 * `recoverTerminalInsuranceAccounts` (dist/index.js: [caller ro, pool w, poolVault w, vaultAuth ro, market w, wrapperVault w,
 * wrapperVaultAuthority ro, tokenProgram ro, wrapperProgram ro]) and `encodeStakeRecoverTerminalInsurance` ([29, u64 LE]);
 * v5 tail per stake 53f5480 instruction.rs tag 29 (FIRST_LOSS [ins_units, creator token], FEE_ONLY [creator token]).
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveStakePool, deriveStakeVaultAuth, deriveVaultAuthority } from "@percolatorct/sdk";
import { DEVNET_PROGRAM_IDS } from "@/lib/program-ids";
import { deriveInsuranceUnitsV22 } from "@/lib/v22/sdk";
import { buildRecoverIxs } from "@/hooks/useRecoverToStakers";

const k = () => Keypair.generate().publicKey;
const CALLER = k();
const MARKET = k();
const STAKE = new PublicKey(DEVNET_PROGRAM_IDS.stake);
const WRAPPER = k();
const MINT = k();
const ADMIN = k();
const VAULT = k();
const poolState = (riskMode: number) => ({ riskMode, poolMode: 0, admin: ADMIN, collateralMint: MINT, vault: VAULT, percolatorProgram: WRAPPER });

describe("buildRecoverIxs (accounts + data vs the SDK tag-29 builder)", () => {
  const pool = deriveStakePool(MARKET, STAKE)[0];
  const [vaultAuth] = deriveStakeVaultAuth(pool, STAKE);
  const [wva] = deriveVaultAuthority(WRAPPER, MARKET);
  const wrapperVault = getAssociatedTokenAddressSync(MINT, wva, true);
  const head = (ix: { keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] }) =>
    ix.keys.slice(0, 9).map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]);
  const expectedHead = [
    [CALLER, false, false],
    [pool, false, true],
    [VAULT, false, true],
    [vaultAuth, false, false],
    [MARKET, false, true],
    [wrapperVault, false, true],
    [wva, false, false],
    [TOKEN_PROGRAM_ID, false, false],
    [WRAPPER, false, false],
  ].map(([p, s, w]) => [(p as PublicKey).toBase58(), s, w]);
  const args = (risk: number) => ({ caller: CALLER, stakeProgram: STAKE, pool, market: MARKET, poolState: poolState(risk) as never, amount: 123_456n });

  it("legacy pool: one ix, 9 accounts, data = [29, u64 LE amount]", () => {
    const ixs = buildRecoverIxs(args(0));
    expect(ixs).toHaveLength(1);
    expect(ixs[0].programId.equals(STAKE)).toBe(true);
    expect(ixs[0].keys).toHaveLength(9);
    expect(head(ixs[0])).toEqual(expectedHead);
    const data = Buffer.from(ixs[0].data);
    expect(data.length).toBe(9);
    expect(data[0]).toBe(29);
    expect(data.readBigUInt64LE(1)).toBe(123_456n);
  });

  it("FIRST_LOSS: idempotent creator ATA first, tail = [ins_units, creator token]", () => {
    const ixs = buildRecoverIxs(args(1));
    const creatorToken = getAssociatedTokenAddressSync(MINT, ADMIN, true);
    expect(ixs).toHaveLength(2);
    expect(ixs[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[0].keys[0].pubkey.equals(CALLER)).toBe(true);
    expect(ixs[0].keys[1].pubkey.equals(creatorToken)).toBe(true);
    expect(ixs[0].keys[2].pubkey.equals(ADMIN)).toBe(true); // owner
    expect(ixs[0].keys[3].pubkey.equals(MINT)).toBe(true); // mint
    expect(Array.from(ixs[0].data)).toEqual([1]); // CreateIdempotent
    expect(head(ixs[1])).toEqual(expectedHead);
    expect(ixs[1].keys).toHaveLength(11);
    expect(ixs[1].keys[9].pubkey.equals(deriveInsuranceUnitsV22(WRAPPER, MARKET)[0])).toBe(true);
    expect(ixs[1].keys[10].pubkey.equals(creatorToken)).toBe(true);
    expect(ixs[1].keys[9].isWritable && ixs[1].keys[10].isWritable).toBe(true);
    expect(Buffer.from(ixs[1].data).readBigUInt64LE(1)).toBe(123_456n);
    expect(Buffer.from(ixs[1].data)[0]).toBe(29);
  });

  it("FEE_ONLY: creator ATA + a single trailing creator token, no ins_units", () => {
    const ixs = buildRecoverIxs(args(2));
    const creatorToken = getAssociatedTokenAddressSync(MINT, ADMIN, true);
    expect(ixs).toHaveLength(2);
    expect(ixs[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(head(ixs[1])).toEqual(expectedHead);
    expect(ixs[1].keys[9].isWritable).toBe(true);
    expect(Buffer.from(ixs[1].data).readBigUInt64LE(1)).toBe(123_456n);
    expect(ixs[1].keys).toHaveLength(10);
    expect(ixs[1].keys[9].pubkey.equals(creatorToken)).toBe(true);
  });
});
