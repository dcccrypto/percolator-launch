import { describe, it, expect } from "vitest";
import { isSaneMarketValue, isActiveMarket } from "@/lib/activeMarketFilter";

describe("isSaneMarketValue", () => {
  it("rejects null and undefined", () => {
    expect(isSaneMarketValue(null)).toBe(false);
    expect(isSaneMarketValue(undefined)).toBe(false);
  });

  it("rejects zero and negative", () => {
    expect(isSaneMarketValue(0)).toBe(false);
    expect(isSaneMarketValue(-1)).toBe(false);
    expect(isSaneMarketValue(-1000)).toBe(false);
  });

  it("rejects sentinel values (u64::MAX ≈ 1.844e19)", () => {
    expect(isSaneMarketValue(1.844674407370955e19)).toBe(false);
    expect(isSaneMarketValue(1e18)).toBe(false);
    expect(isSaneMarketValue(1e19)).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    expect(isSaneMarketValue(NaN)).toBe(false);
    expect(isSaneMarketValue(Infinity)).toBe(false);
    expect(isSaneMarketValue(-Infinity)).toBe(false);
  });

  it("accepts normal positive values", () => {
    expect(isSaneMarketValue(1)).toBe(true);
    expect(isSaneMarketValue(0.001)).toBe(true);
    expect(isSaneMarketValue(1000000)).toBe(true);
    expect(isSaneMarketValue(999999999999999)).toBe(true); // < 1e18
  });
});

describe("isActiveMarket", () => {
  it("returns false for empty market (all nulls)", () => {
    expect(isActiveMarket({})).toBe(false);
    expect(isActiveMarket({ last_price: null, volume_24h: null, total_open_interest: null })).toBe(false);
  });

  it("returns false for market with all zero values", () => {
    expect(isActiveMarket({ last_price: 0, volume_24h: 0, total_open_interest: 0 })).toBe(false);
  });

  it("returns false for market with sentinel values only", () => {
    expect(isActiveMarket({
      last_price: 1.844674407370955e19,
      volume_24h: 1.844674407370955e19,
      total_open_interest: 1.844674407370955e19,
    })).toBe(false);
  });

  it("returns true for market with sane price", () => {
    expect(isActiveMarket({ last_price: 148.52, volume_24h: 0, total_open_interest: 0 })).toBe(true);
  });

  it("returns true for market with sane volume", () => {
    expect(isActiveMarket({ last_price: 0, volume_24h: 1000, total_open_interest: 0 })).toBe(true);
  });

  it("returns true for market with sane OI", () => {
    expect(isActiveMarket({ last_price: 0, volume_24h: 0, total_open_interest: 50000 })).toBe(true);
  });

  it("returns true for market with combined OI from long + short", () => {
    expect(isActiveMarket({
      last_price: 0,
      volume_24h: 0,
      total_open_interest: 0,
      open_interest_long: 30000,
      open_interest_short: 20000,
    })).toBe(true);
  });

  it("returns false when combined OI is zero", () => {
    expect(isActiveMarket({
      last_price: 0,
      volume_24h: 0,
      total_open_interest: 0,
      open_interest_long: 0,
      open_interest_short: 0,
    })).toBe(false);
  });
});
