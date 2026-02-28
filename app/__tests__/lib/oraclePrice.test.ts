import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { detectOracleMode, resolveMarketPriceE6, priceE6ToUsd, sanitizePriceE6, MAX_PRICE_E6 } from "../../lib/oraclePrice";

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

describe("sanitizePriceE6", () => {
  it("passes through valid prices", () => {
    expect(sanitizePriceE6(150_000_000n)).toBe(150_000_000n); // $150
    expect(sanitizePriceE6(1n)).toBe(1n); // tiny but valid
    expect(sanitizePriceE6(MAX_PRICE_E6)).toBe(MAX_PRICE_E6); // exactly at limit ($1B)
  });

  it("returns 0n for prices exceeding MAX_ORACLE_PRICE", () => {
    expect(sanitizePriceE6(MAX_PRICE_E6 + 1n)).toBe(0n);
    // The $13T bug value: 13_065_687_626_137_560_000n
    expect(sanitizePriceE6(13_065_687_626_137_560_000n)).toBe(0n);
  });

  it("returns 0n for zero and negative prices", () => {
    expect(sanitizePriceE6(0n)).toBe(0n);
    expect(sanitizePriceE6(-1n)).toBe(0n);
    expect(sanitizePriceE6(-999_999n)).toBe(0n);
  });

  it("returns 0n for u64::MAX sentinel values", () => {
    const U64_MAX = 18446744073709551615n;
    expect(sanitizePriceE6(U64_MAX)).toBe(0n);
  });
});

describe("resolveMarketPriceE6 sanitization", () => {
  it("returns 0n for bogus lastEffectivePriceE6 in pyth-pinned mode", () => {
    const result = resolveMarketPriceE6({
      oracleAuthority: ZERO_KEY,
      indexFeedId: NON_ZERO_KEY,
      lastEffectivePriceE6: 13_065_687_626_137_560_000n, // $13T — bogus
      authorityPriceE6: 0n,
    });
    expect(result).toBe(0n);
  });

  it("returns 0n for bogus authorityPriceE6 in admin mode", () => {
    const result = resolveMarketPriceE6({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ANOTHER_KEY,
      lastEffectivePriceE6: 0n,
      authorityPriceE6: 99_999_999_999_999_999n, // way above $1B
    });
    expect(result).toBe(0n);
  });

  it("returns 0n for u64::MAX sentinel in hyperp mode", () => {
    const U64_MAX = 18446744073709551615n;
    const result = resolveMarketPriceE6({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ZERO_KEY,
      lastEffectivePriceE6: U64_MAX,
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
