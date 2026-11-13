// @vitest-environment node
/**
 * Tests for validateNumericParam — strict integer enforcement (GH#1490 follow-up).
 * Ensures floats, trailing-garbage strings, and out-of-range values are rejected.
 */
import { validateNumericParam } from "@/lib/route-validators";

describe("validateNumericParam", () => {
  describe("strict integer check", () => {
    it("accepts a valid positive integer string", () => {
      const result = validateNumericParam("10", { min: 1, max: 500 });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.value).toBe(10);
    });

    it("accepts zero when min is 0", () => {
      const result = validateNumericParam("0", { min: 0 });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.value).toBe(0);
    });

    it("rejects float string '1.5'", () => {
      const result = validateNumericParam("1.5", { min: 1, max: 500 });
      expect(result.valid).toBe(false);
    });

    it("rejects trailing-garbage string '20abc'", () => {
      const result = validateNumericParam("20abc", { min: 1, max: 500 });
      expect(result.valid).toBe(false);
    });

    it("rejects empty string", () => {
      const result = validateNumericParam("", { min: 0 });
      expect(result.valid).toBe(false);
    });

    it("rejects null", () => {
      const result = validateNumericParam(null, { min: 0 });
      expect(result.valid).toBe(false);
    });

    it("rejects undefined", () => {
      const result = validateNumericParam(undefined, { min: 0 });
      expect(result.valid).toBe(false);
    });

    it("rejects NaN string", () => {
      const result = validateNumericParam("NaN", { min: 0 });
      expect(result.valid).toBe(false);
    });

    it("rejects leading-space string ' 10'", () => {
      const result = validateNumericParam(" 10", { min: 0 });
      expect(result.valid).toBe(false);
    });
  });

  describe("range enforcement", () => {
    it("rejects value below min", () => {
      const result = validateNumericParam("0", { min: 1, max: 500 });
      expect(result.valid).toBe(false);
    });

    it("rejects value above max", () => {
      const result = validateNumericParam("501", { min: 1, max: 500 });
      expect(result.valid).toBe(false);
    });

    it("accepts value at exactly min", () => {
      const result = validateNumericParam("1", { min: 1, max: 500 });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.value).toBe(1);
    });

    it("accepts value at exactly max", () => {
      const result = validateNumericParam("500", { min: 1, max: 500 });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.value).toBe(500);
    });
  });
});
