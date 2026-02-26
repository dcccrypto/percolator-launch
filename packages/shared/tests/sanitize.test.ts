import { describe, it, expect } from "vitest";
import {
  sanitizeString,
  sanitizeSlabAddress,
  sanitizePagination,
  sanitizeNumber,
  sanitizeBigIntForDb,
  sanitizeBigIntToString,
} from "../src/sanitize.js";

describe("sanitize", () => {
  describe("sanitizeString", () => {
    it("should trim whitespace", () => {
      expect(sanitizeString("  hello  ")).toBe("hello");
      expect(sanitizeString("\t\ntrim me\n\t")).toBe("trim me");
    });

    it("should remove null bytes and control characters", () => {
      expect(sanitizeString("hello\x00world")).toBe("helloworld");
      expect(sanitizeString("test\x01\x02\x03data")).toBe("testdata");
      expect(sanitizeString("control\x1F\x7Fchars")).toBe("controlchars");
    });

    it("should limit length to maxLength", () => {
      const longString = "a".repeat(2000);
      
      expect(sanitizeString(longString, 100)).toBe("a".repeat(100));
      expect(sanitizeString(longString, 500)).toBe("a".repeat(500));
    });

    it("should use default maxLength of 1000", () => {
      const longString = "a".repeat(2000);
      
      expect(sanitizeString(longString)).toBe("a".repeat(1000));
    });

    it("should handle empty strings", () => {
      expect(sanitizeString("")).toBe("");
      expect(sanitizeString("   ")).toBe("");
    });

    it("should return empty string for non-string input", () => {
      expect(sanitizeString(123 as any)).toBe("");
      expect(sanitizeString(null as any)).toBe("");
      expect(sanitizeString(undefined as any)).toBe("");
      expect(sanitizeString({} as any)).toBe("");
    });

    it("should preserve valid unicode characters", () => {
      expect(sanitizeString("Hello 世界 🌍")).toBe("Hello 世界 🌍");
    });

    it("should handle maxLength of 0 (no limit)", () => {
      const longString = "a".repeat(5000);
      
      expect(sanitizeString(longString, 0)).toBe(longString);
    });
  });

  describe("sanitizeSlabAddress", () => {
    it("should accept valid Solana addresses", () => {
      const validAddresses = [
        "11111111111111111111111111111111",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "So11111111111111111111111111111111111112",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      ];

      validAddresses.forEach((address) => {
        expect(sanitizeSlabAddress(address)).toBe(address);
      });
    });

    it("should trim whitespace before validation", () => {
      const address = "  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA  ";
      
      expect(sanitizeSlabAddress(address)).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    });

    it("should reject addresses that are too short", () => {
      expect(sanitizeSlabAddress("tooShort123")).toBeNull();
      expect(sanitizeSlabAddress("12345678901234567890123")).toBeNull();
    });

    it("should truncate addresses that are too long to maxLength", () => {
      // sanitizeSlabAddress calls sanitizeString with maxLength=44
      // So a 45-char input gets truncated to 44, which is valid
      const tooLong = "1".repeat(45);
      
      // Returns truncated version (44 chars)
      expect(sanitizeSlabAddress(tooLong)).toBe("1".repeat(44));
    });

    it("should reject addresses with invalid base58 characters", () => {
      const invalidChars = [
        "11111111111111111111111111111110", // Contains 0
        "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO", // Contains O
        "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIiii", // Contains I
        "llllllllllllllllllllllllllllllll", // Contains l
        "11111111111111111111111111111!11", // Special char
        "1111111111111111111111111111 111", // Space
      ];

      invalidChars.forEach((address) => {
        expect(sanitizeSlabAddress(address)).toBeNull();
      });
    });

    it("should return null for non-string input", () => {
      expect(sanitizeSlabAddress(123 as any)).toBeNull();
      expect(sanitizeSlabAddress(null as any)).toBeNull();
      expect(sanitizeSlabAddress(undefined as any)).toBeNull();
      expect(sanitizeSlabAddress({} as any)).toBeNull();
    });

    it("should accept addresses at exact min/max boundaries", () => {
      const minLength = "A".repeat(32);
      const maxLength = "B".repeat(44);
      
      expect(sanitizeSlabAddress(minLength)).toBe(minLength);
      expect(sanitizeSlabAddress(maxLength)).toBe(maxLength);
    });

    it("should reject empty string", () => {
      expect(sanitizeSlabAddress("")).toBeNull();
    });
  });

  describe("sanitizePagination", () => {
    it("should use defaults when no input provided", () => {
      const result = sanitizePagination();
      
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it("should accept valid number inputs", () => {
      const result = sanitizePagination(100, 200);
      
      expect(result.limit).toBe(100);
      expect(result.offset).toBe(200);
    });

    it("should parse string numbers", () => {
      const result = sanitizePagination("75", "150");
      
      expect(result.limit).toBe(75);
      expect(result.offset).toBe(150);
    });

    it("should clamp limit to max of 500", () => {
      const result = sanitizePagination(1000);
      
      expect(result.limit).toBe(500);
    });

    it("should clamp limit to min of 1", () => {
      const result = sanitizePagination(0);
      
      expect(result.limit).toBe(1);
    });

    it("should clamp offset to min of 0", () => {
      const result = sanitizePagination(50, -100);
      
      expect(result.offset).toBe(0);
    });

    it("should clamp offset to max of 100000", () => {
      const result = sanitizePagination(50, 200000);
      
      expect(result.offset).toBe(100000);
    });

    it("should floor decimal numbers", () => {
      const result = sanitizePagination(25.7, 99.9);
      
      expect(result.limit).toBe(25);
      expect(result.offset).toBe(99);
    });

    it("should handle invalid string inputs with defaults", () => {
      const result = sanitizePagination("invalid", "notanumber");
      
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it("should handle mixed valid and invalid inputs", () => {
      const result1 = sanitizePagination(30, "invalid");
      const result2 = sanitizePagination("invalid", 50);
      
      expect(result1.limit).toBe(30);
      expect(result1.offset).toBe(0);
      
      expect(result2.limit).toBe(50);
      expect(result2.offset).toBe(50);
    });

    it("should handle null and undefined inputs", () => {
      const result = sanitizePagination(null as any, undefined);
      
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });
  });

  describe("sanitizeNumber", () => {
    it("should accept valid number input", () => {
      expect(sanitizeNumber(42)).toBe(42);
      expect(sanitizeNumber(3.14)).toBe(3.14);
      expect(sanitizeNumber(0)).toBe(0);
    });

    it("should parse valid string numbers", () => {
      expect(sanitizeNumber("123")).toBe(123);
      expect(sanitizeNumber("45.67")).toBe(45.67);
      expect(sanitizeNumber("0")).toBe(0);
    });

    it("should reject invalid string inputs", () => {
      expect(sanitizeNumber("not a number")).toBeNull();
      expect(sanitizeNumber("abc123")).toBeNull();
      expect(sanitizeNumber("")).toBeNull();
    });

    it("should reject non-numeric types", () => {
      expect(sanitizeNumber(null)).toBeNull();
      expect(sanitizeNumber(undefined)).toBeNull();
      expect(sanitizeNumber({})).toBeNull();
      expect(sanitizeNumber([])).toBeNull();
    });

    it("should reject infinite values", () => {
      expect(sanitizeNumber(Infinity)).toBeNull();
      expect(sanitizeNumber(-Infinity)).toBeNull();
    });

    it("should reject NaN", () => {
      expect(sanitizeNumber(NaN)).toBeNull();
    });

    it("should enforce minimum constraint", () => {
      expect(sanitizeNumber(5, 10)).toBeNull();
      expect(sanitizeNumber(10, 10)).toBe(10);
      expect(sanitizeNumber(15, 10)).toBe(15);
    });

    it("should enforce maximum constraint", () => {
      expect(sanitizeNumber(105, undefined, 100)).toBeNull();
      expect(sanitizeNumber(100, undefined, 100)).toBe(100);
      expect(sanitizeNumber(95, undefined, 100)).toBe(95);
    });

    it("should enforce both min and max constraints", () => {
      expect(sanitizeNumber(5, 10, 20)).toBeNull();
      expect(sanitizeNumber(10, 10, 20)).toBe(10);
      expect(sanitizeNumber(15, 10, 20)).toBe(15);
      expect(sanitizeNumber(20, 10, 20)).toBe(20);
      expect(sanitizeNumber(25, 10, 20)).toBeNull();
    });

    it("should handle negative numbers", () => {
      expect(sanitizeNumber(-42)).toBe(-42);
      expect(sanitizeNumber("-15.5")).toBe(-15.5);
      expect(sanitizeNumber(-10, -20, 0)).toBe(-10);
    });

    it("should handle zero in constraints", () => {
      expect(sanitizeNumber(0, 0, 10)).toBe(0);
      expect(sanitizeNumber(-5, 0, 10)).toBeNull();
      expect(sanitizeNumber(5, 0, 0)).toBeNull();
    });

    it("should parse scientific notation strings", () => {
      expect(sanitizeNumber("1e5")).toBe(100000);
      expect(sanitizeNumber("2.5e2")).toBe(250);
    });
  });

  describe("sanitizeBigIntForDb", () => {
    const U64_MAX = 18_446_744_073_709_551_615n;
    const PG_BIGINT_MAX = 9_223_372_036_854_775_807n;

    it("should pass through normal values", () => {
      expect(sanitizeBigIntForDb(0n)).toBe(0);
      expect(sanitizeBigIntForDb(1n)).toBe(1);
      expect(sanitizeBigIntForDb(1_000_000n)).toBe(1_000_000);
      expect(sanitizeBigIntForDb(-500n)).toBe(-500);
    });

    it("should replace u64::MAX sentinel with 0", () => {
      expect(sanitizeBigIntForDb(U64_MAX)).toBe(0);
    });

    it("should replace near-sentinel values (≥90% of u64::MAX) with 0", () => {
      // 90% of u64::MAX ≈ 16.6e18
      const nearSentinel = (U64_MAX * 9n) / 10n;
      expect(sanitizeBigIntForDb(nearSentinel)).toBe(0);
      expect(sanitizeBigIntForDb(nearSentinel + 1n)).toBe(0);
    });

    it("should replace values exceeding PG bigint max with 0", () => {
      expect(sanitizeBigIntForDb(PG_BIGINT_MAX + 1n)).toBe(0);
      // This is the exact value from the bug report (after Number() lossy conversion)
      expect(sanitizeBigIntForDb(13_292_928_068_290_159_000n)).toBe(0);
    });

    it("should accept values at PG bigint max boundary", () => {
      expect(sanitizeBigIntForDb(PG_BIGINT_MAX)).toBe(Number(PG_BIGINT_MAX));
    });

    it("should handle negative sentinel-like values", () => {
      expect(sanitizeBigIntForDb(-U64_MAX)).toBe(0);
      const negSentinel = -(U64_MAX * 9n) / 10n;
      expect(sanitizeBigIntForDb(negSentinel)).toBe(0);
    });

    it("should handle negative values exceeding PG bigint min", () => {
      expect(sanitizeBigIntForDb(-PG_BIGINT_MAX - 1n)).toBe(0);
    });

    it("should use custom fallback when provided", () => {
      expect(sanitizeBigIntForDb(U64_MAX, -1)).toBe(-1);
      expect(sanitizeBigIntForDb(U64_MAX, 100)).toBe(100);
    });

    it("should handle typical on-chain values correctly", () => {
      // Typical Solana slot number
      expect(sanitizeBigIntForDb(350_000_000n)).toBe(350_000_000);
      // Typical token amount (1 SOL in lamports)
      expect(sanitizeBigIntForDb(1_000_000_000n)).toBe(1_000_000_000);
      // Large but valid OI value
      expect(sanitizeBigIntForDb(5_000_000_000_000n)).toBe(5_000_000_000_000);
    });
  });

  describe("sanitizeBigIntToString", () => {
    const U64_MAX = 18_446_744_073_709_551_615n;

    it("should convert normal values to string", () => {
      expect(sanitizeBigIntToString(0n)).toBe("0");
      expect(sanitizeBigIntToString(12345n)).toBe("12345");
      expect(sanitizeBigIntToString(-999n)).toBe("-999");
    });

    it("should replace u64::MAX sentinel with '0'", () => {
      expect(sanitizeBigIntToString(U64_MAX)).toBe("0");
    });

    it("should replace near-sentinel values with '0'", () => {
      const nearSentinel = (U64_MAX * 95n) / 100n;
      expect(sanitizeBigIntToString(nearSentinel)).toBe("0");
    });

    it("should use custom fallback string", () => {
      expect(sanitizeBigIntToString(U64_MAX, "null")).toBe("null");
      expect(sanitizeBigIntToString(U64_MAX, "-1")).toBe("-1");
    });

    it("should preserve full precision for large but valid values", () => {
      const largeValid = 9_000_000_000_000_000_000n; // < PG max
      expect(sanitizeBigIntToString(largeValid)).toBe("9000000000000000000");
    });
  });
});
