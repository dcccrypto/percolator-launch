// @vitest-environment node
/**
 * #3611: when neither the chain read nor the API can value a stake (a first-loss pool whose insurance units could not
 * be read has `tvl: null`), the value is unknown: null (a dash), never a number computed from a partial TVL.
 */
import { describe, expect, it } from "vitest";
import { valueStakePosition } from "@/lib/stake-position";
import { stakedOrderValue } from "@/lib/stake-pool-order";

const base = { lpRaw: 500_000_000n, chainTotalLpSupplyRaw: 1_000_000_000n, apiTotalLpSupply: 1_000_000_000, lpDecimals: 6 };

describe("#3611 valueStakePosition with no usable value", () => {
  it("chain value unknown and API tvl null: null, not 0 and not a guess", () => {
    expect(valueStakePosition({ ...base, chainVaultAtoms: null, apiTvlUsd: null })).toBeNull();
  });
  it("chain value unknown, API tvl known (it already includes deployed): the API share", () => {
    expect(valueStakePosition({ ...base, chainVaultAtoms: null, apiTvlUsd: 900 })).toBe(450);
  });
  it("chain value known: the chain share, whatever the API says", () => {
    expect(valueStakePosition({ ...base, chainVaultAtoms: 800_000_000n, apiTvlUsd: null })).toBe(400);
  });
  it("legacy numbers are unchanged (empty supply still values at 0)", () => {
    expect(valueStakePosition({ ...base, chainTotalLpSupplyRaw: null, chainVaultAtoms: null, apiTotalLpSupply: 0, apiTvlUsd: 100 })).toBe(0);
  });
  it("a staked position with an unknown value still sorts with the staked pools", () => {
    expect(stakedOrderValue(5n, null)).toBe(Number.MIN_VALUE);
    expect(stakedOrderValue(0n, null)).toBe(0);
  });
});
