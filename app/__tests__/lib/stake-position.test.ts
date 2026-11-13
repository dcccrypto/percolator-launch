// @vitest-environment node
/**
 * Live report 2026-10-01 (wallet 9sM73A..., pool 8WC8vALs...): after a 400 USDC stake the
 * "Your Deposits" hero stayed "$—" and the pool row's "Your Stake" read "$0.00". The position was
 * valued from the CDN-cached /api/stake/pools snapshot, which predates a first deposit into a
 * fresh pool (supply 0, tvl 0). The numbers below are the real on-chain ones from that deposit.
 */
import { describe, it, expect } from "vitest";
import { readPoolTotalLpSupply, stakeValueAtoms, valueStakePosition } from "@/lib/stake-position";

// tx EGwSvb3X: 400 USDC deposited, 399,999,000 LP minted to the wallet, 1,000 locked.
const LP = 399_999_000n;
const CHAIN_SUPPLY = 400_000_000n;
const CHAIN_VAULT = 400_000_000n;

describe("valueStakePosition", () => {
  it("values a fresh stake from chain even when the cached API snapshot is the pre-deposit one", () => {
    const usd = valueStakePosition({
      lpRaw: LP,
      chainTotalLpSupplyRaw: CHAIN_SUPPLY,
      chainVaultAtoms: CHAIN_VAULT,
      apiTotalLpSupply: 0, // stale: pool was empty
      apiTvlUsd: 0,
      lpDecimals: 6,
    });
    expect(usd).toBeCloseTo(399.999, 3);
    expect(usd).toBeGreaterThan(0);
  });

  it("falls back to the API snapshot only when the chain read is unavailable", () => {
    const usd = valueStakePosition({
      lpRaw: LP,
      chainTotalLpSupplyRaw: null,
      chainVaultAtoms: null,
      apiTotalLpSupply: 400_000_000,
      apiTvlUsd: 400,
      lpDecimals: 6,
    });
    expect(usd).toBeCloseTo(399.999, 3);
  });

  it("includes accrued fees in the vault (redemption value above 1:1)", () => {
    const usd = valueStakePosition({
      lpRaw: LP, chainTotalLpSupplyRaw: CHAIN_SUPPLY, chainVaultAtoms: 400_008_005n,
      apiTotalLpSupply: 0, apiTvlUsd: 0, lpDecimals: 6,
    });
    expect(usd).toBeCloseTo(400.007, 3);
  });
});

describe("stakeValueAtoms / readPoolTotalLpSupply", () => {
  it("is null with no supply and exact otherwise", () => {
    expect(stakeValueAtoms(5n, 0n, 100n)).toBeNull();
    expect(stakeValueAtoms(LP, CHAIN_SUPPLY, CHAIN_VAULT)).toBe(399_999_000n);
  });
  it("reads total_lp_supply at offset 176 of a 408-byte pool account", () => {
    const data = new Uint8Array(408);
    new DataView(data.buffer).setBigUint64(176, CHAIN_SUPPLY, true);
    expect(readPoolTotalLpSupply(data)).toBe(CHAIN_SUPPLY);
    expect(readPoolTotalLpSupply(new Uint8Array(100))).toBeNull();
  });
});
