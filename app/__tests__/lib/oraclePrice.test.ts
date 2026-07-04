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

  it("returns 'keeper' when oracleModeByte=3 (AUTH_MARK), regardless of key structure", () => {
    // v17 AUTH_MARK: indexFeedId is ZERO (SlabProvider forces it), oracleAuthority is the LP registry key.
    // Without oracleModeByte, key-based detection would return "hyperp" — wrong label.
    expect(detectOracleMode({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ZERO_KEY,
      oracleModeByte: 3,
    })).toBe("keeper");
  });

  it("returns 'keeper' with oracleModeByte=3 even when both keys are non-zero", () => {
    expect(detectOracleMode({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ANOTHER_KEY,
      oracleModeByte: 3,
    })).toBe("keeper");
  });

  it("ignores oracleModeByte=0 (falls through to key-based detection)", () => {
    // byte=0 = MANUAL/ADMIN — key-based detection is authoritative
    expect(detectOracleMode({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ZERO_KEY,
      oracleModeByte: 0,
    })).toBe("hyperp");
    expect(detectOracleMode({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ANOTHER_KEY,
      oracleModeByte: 0,
    })).toBe("admin");
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

  it("uses lastEffectivePriceE6 for keeper markets (oracleModeByte=3, AUTH_MARK)", () => {
    // keeper: markEwmaE6 is in lastEffectivePriceE6 (set via PushAuthMark crank)
    const result = resolveMarketPriceE6({
      oracleAuthority: NON_ZERO_KEY,
      indexFeedId: ZERO_KEY,   // SlabProvider forces ZERO for v17 AUTH_MARK markets
      lastEffectivePriceE6: 148_500_000n, // ~$148.50 SOL
      authorityPriceE6: 0n,
      oracleModeByte: 3,
    });
    expect(result).toBe(148_500_000n);
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

// GH#1990: applyInvert tests — critical for inverted-market risk math correctness
import { applyInvert } from "../../lib/oraclePrice";

describe("applyInvert (GH#1990)", () => {
  it("returns price unchanged when invert=0", () => {
    expect(applyInvert(100_000_000n, 0)).toBe(100_000_000n);
  });

  it("returns price unchanged when invert=undefined", () => {
    expect(applyInvert(100_000_000n, undefined)).toBe(100_000_000n);
  });

  it("returns 0n when priceE6=0 (division-by-zero guard)", () => {
    expect(applyInvert(0n, 1)).toBe(0n);
  });

  it("inverts $100 oracle to 10_000 (USD per USDC ≈ 0.00001)", () => {
    // $100 raw → inverted = 1e12 / 100e6 = 10_000
    expect(applyInvert(100_000_000n, 1)).toBe(10_000n);
  });

  it("inverts $200 oracle to 5_000", () => {
    // $200 raw → inverted = 1e12 / 200e6 = 5_000
    expect(applyInvert(200_000_000n, 1)).toBe(5_000n);
  });

  it("double-invert round-trips approximately for typical prices", () => {
    // applyInvert(applyInvert(rawE6)) ≈ rawE6 with BigInt truncation error.
    // Error grows as: err ≈ raw² / 1e12. For raw=$150 (150_000_000 e6):
    // inverted = 1e12/150e6 = 6_666 (truncated). reinverted = 1e12/6_666 = 150_007_500.
    // Relative error < 0.01% is acceptable.
    const raw = 150_000_000n; // $150
    const inverted = applyInvert(raw, 1);
    const reinverted = applyInvert(inverted, 1);
    // Allow up to 0.1% relative error (BigInt integer division accumulates truncation)
    const diff = reinverted > raw ? reinverted - raw : raw - reinverted;
    const relErrorBps = (diff * 10000n) / raw;
    expect(Number(relErrorBps)).toBeLessThan(10); // < 10bps = 0.1%
  });

  it("inverted mark price relative to inverted entry yields correct PnL direction", () => {
    // Standard oracle: SOL = $100 → long profits when price goes up
    // Inverted oracle: USDC/SOL = 1/100 → long profits when SOL goes DOWN (inverted price goes up)
    const entryInverted = applyInvert(100_000_000n, 1); // 10_000
    const markInverted_solDown = applyInvert(90_000_000n, 1);  // 11_111 > entry → profit for long
    const markInverted_solUp = applyInvert(110_000_000n, 1);   // 9_090 < entry → loss for long
    expect(markInverted_solDown).toBeGreaterThan(entryInverted);
    expect(markInverted_solUp).toBeLessThan(entryInverted);
  });
});
