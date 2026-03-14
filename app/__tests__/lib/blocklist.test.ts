import { BLOCKED_SLAB_ADDRESSES, isBlockedSlab } from "@/lib/blocklist";

describe("blocklist", () => {
  it("contains BxJPaMaC stale market", () => {
    expect(BLOCKED_SLAB_ADDRESSES.has("BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP")).toBe(true);
  });

  it("isBlockedSlab returns true for known bad address", () => {
    expect(isBlockedSlab("BxJPaMaCfEGTBsjZ8wfj3Yfzf4wpasmxKAEvqZZRcGPP")).toBe(true);
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
