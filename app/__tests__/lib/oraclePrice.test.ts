import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { detectOracleMode, resolveMarketPriceE6, priceE6ToUsd } from "../../lib/oraclePrice";

const ZERO_KEY = new PublicKey(new Uint8Array(32));
const NON_ZERO_KEY = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const ANOTHER_KEY = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

describe("detectOracleMode", () => {
  it("returns 'hyperp' when indexFeedId is zero", () => {
    expect(detectOracleMode({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ZERO_KEY,
    })).toBe("hyperp");
  });

  it("returns 'pyth-pinned' when oracleAuthority is zero and indexFeedId is non-zero", () => {
    expect(detectOracleMode({
      oracleAuthority: ZERO_KEY,
      indexFeedId: NON_ZERO_KEY,
    })).toBe("pyth-pinned");
  });

  it("returns 'admin' when both are non-zero", () => {
    expect(detectOracleMode({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ANOTHER_KEY,
    })).toBe("admin");
  });

  it("returns 'hyperp' when both are zero (indexFeedId check takes priority)", () => {
    expect(detectOracleMode({
      oracleAuthority: ZERO_KEY,
      indexFeedId: ZERO_KEY,
    })).toBe("hyperp");
  });
});

describe("resolveMarketPriceE6", () => {
  it("uses lastEffectivePriceE6 for pyth-pinned markets", () => {
    const result = resolveMarketPriceE6({
      oracleAuthority: ZERO_KEY,
      indexFeedId: NON_ZERO_KEY,
      lastEffectivePriceE6: 150_000_000n,
      authorityPriceE6: 999_999_999_999n, // stale/garbage — should be ignored
    });
    expect(result).toBe(150_000_000n);
  });

  it("uses lastEffectivePriceE6 for hyperp markets", () => {
    const result = resolveMarketPriceE6({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ZERO_KEY,
      lastEffectivePriceE6: 4_190_000n,
      authorityPriceE6: 4_187_729_446_681_120_000n, // inflated mark price — should be ignored
    });
    expect(result).toBe(4_190_000n);
  });

  it("uses authorityPriceE6 for admin oracle markets", () => {
    const result = resolveMarketPriceE6({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ANOTHER_KEY,
      lastEffectivePriceE6: 1_000_000n,
      authorityPriceE6: 1_500_000n,
    });
    expect(result).toBe(1_500_000n);
  });

  it("falls back to lastEffectivePriceE6 for admin markets when authorityPriceE6 is 0", () => {
    const result = resolveMarketPriceE6({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ANOTHER_KEY,
      lastEffectivePriceE6: 2_000_000n,
      authorityPriceE6: 0n,
    });
    expect(result).toBe(2_000_000n);
  });

  it("returns 0n when no valid price is available", () => {
    const result = resolveMarketPriceE6({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ANOTHER_KEY,
      lastEffectivePriceE6: 0n,
      authorityPriceE6: 0n,
    });
    expect(result).toBe(0n);
  });
});

describe("priceE6ToUsd", () => {
  it("converts E6 to USD", () => {
    expect(priceE6ToUsd(1_500_000n)).toBe(1.5);
    expect(priceE6ToUsd(150_000_000n)).toBe(150);
    expect(priceE6ToUsd(1_000n)).toBe(0.001);
  });

  it("returns null for 0 or negative", () => {
    expect(priceE6ToUsd(0n)).toBeNull();
    expect(priceE6ToUsd(-1n)).toBeNull();
  });
});
