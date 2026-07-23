/**
 * Regression guard for the devnet-2 stake-program cutover.
 *
 * The fresh devnet stake program (GCHhcgwPyrai8SWHEVWw3odedguFXEtJobNnWSfWBCU3)
 * deploys 392-byte StakePool accounts (v2 layout). The app previously assumed a
 * 352-byte layout, which made `getProgramAccounts({ filters:[{ dataSize:352 }] })`
 * in /api/stake/pools match ZERO real pools (stake + earn showed no pools).
 *
 * These assertions pin the two invariants that keep that route (and the
 * frontend decoder) correct against the deployed shape:
 *   1. the SDK's STAKE_POOL_SIZE — which the route now imports for its dataSize
 *      filter — equals the deployed 392;
 *   2. decodeStakePoolV1 reads the five frontend fields correctly from a real
 *      392-byte account (offsets are identical across the 352/392 layouts).
 */
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { STAKE_POOL_SIZE } from "@percolatorct/sdk";
import { decodeStakePoolV1, STAKE_POOL_SIZE_V1 } from "@/hooks/useStakePool";

describe("stake pool size — devnet-2 cutover", () => {
  it("SDK STAKE_POOL_SIZE matches the deployed 392-byte v2 layout (not the retired 352)", () => {
    expect(STAKE_POOL_SIZE).toBe(392);
    expect(STAKE_POOL_SIZE).not.toBe(352);
  });

  it("STAKE_POOL_SIZE_V1 is a valid minimum floor cleared by a real 392-byte pool", () => {
    expect(STAKE_POOL_SIZE_V1).toBeLessThanOrEqual(STAKE_POOL_SIZE);
  });

  it("decodeStakePoolV1 reads lpMint/vault/cooldown/cap from a 392-byte account", () => {
    const lpMint = new PublicKey("GHreicn6XAGNqZhPKnmTg6k6pfkfgHKwkYZzUNy5fSis");
    const vault = new PublicKey("2pKMBdnueCgAA27wR8ZNGZjT7ykNTEzuQqAWrEyqn1Ak");

    const data = new Uint8Array(392); // deployed v2 size
    data[0] = 1; // is_initialized
    data.set(lpMint.toBytes(), 104);
    data.set(vault.toBytes(), 136);
    const dv = new DataView(data.buffer);
    dv.setBigUint64(184, 5n, true); // cooldown_slots
    dv.setBigUint64(192, 1_000_000_000_000n, true); // deposit_cap

    const decoded = decodeStakePoolV1(data);
    expect(decoded.isInitialized).toBe(true);
    expect(decoded.lpMint.toBase58()).toBe(lpMint.toBase58());
    expect(decoded.vault.toBase58()).toBe(vault.toBase58());
    expect(decoded.cooldownSlots).toBe(5n);
    expect(decoded.depositCap).toBe(1_000_000_000_000n);
  });
});
