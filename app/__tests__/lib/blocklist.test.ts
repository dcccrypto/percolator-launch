// @vitest-environment node
import { BLOCKED_SLAB_ADDRESSES, isBlockedSlab } from "@/lib/blocklist";

describe("blocklist", () => {
  it("contains BxJPaMaC stale market", () => {
    expect(BLOCKED_SLAB_ADDRESSES.has("BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP")).toBe(true);
  });

  it("isBlockedSlab returns true for known bad address", () => {
    expect(isBlockedSlab("BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP")).toBe(true);
  });

  // GH#1357 / PR#1377: NL no-liquidity slabs hardcoded into blocklist
  it("blocks 3bmCyPee SEX/USD slab (PR #1377)", () => {
    expect(isBlockedSlab("3bmCyPee8GWJR5aPGTyN5EyyQJLzYyD8Wkg9m1Afd1SD")).toBe(true);
  });

  it("blocks 3YDqCJGz phantom-OI slab (PR #1377)", () => {
    expect(isBlockedSlab("3YDqCJGz88xGiPBiRvx4vrM51mWTiTZPZ95hxYDZqKpJ")).toBe(true);
  });

  it("blocks 3ZKKwsKoo empty-vault slab (PR #1377)", () => {
    expect(isBlockedSlab("3ZKKwsKoo5UP28cYmMpvGpwoFpWLVgEWLQJCejJnECQn")).toBe(true);
  });

  it("isBlockedSlab returns false for a valid market address", () => {
    expect(isBlockedSlab("SomeValidMarketAddressNotInBlocklist1234567")).toBe(false);
  });

  it("isBlockedSlab returns false for null", () => {
    expect(isBlockedSlab(null)).toBe(false);
  });

  it("isBlockedSlab returns false for undefined", () => {
    expect(isBlockedSlab(undefined)).toBe(false);
  });

  it("isBlockedSlab returns false for empty string", () => {
    expect(isBlockedSlab("")).toBe(false);
  });
});
