import { describe, it, expect } from "vitest";
import { formatCompact } from "@/lib/formatters";

describe("formatCompact", () => {
  it("formats trillions", () => {
    expect(formatCompact(1.5e12)).toBe("1.50T");
  });

  it("formats billions", () => {
    expect(formatCompact(2.3e9)).toBe("2.30B");
  });

  it("formats millions", () => {
    expect(formatCompact(4.567e6)).toBe("4.57M");
  });

  it("formats thousands", () => {
    expect(formatCompact(12_345)).toBe("12.35K");
  });

  it("formats numbers below 1000", () => {
    expect(formatCompact(999)).toBe("999.00");
  });

  it("formats zero", () => {
    expect(formatCompact(0)).toBe("0.00");
  });

  it("formats exactly 1000", () => {
    expect(formatCompact(1000)).toBe("1.00K");
  });

  it("formats exactly 1 million", () => {
    expect(formatCompact(1e6)).toBe("1.00M");
  });

  it("formats exactly 1 billion", () => {
    expect(formatCompact(1e9)).toBe("1.00B");
  });

  it("formats exactly 1 trillion", () => {
    expect(formatCompact(1e12)).toBe("1.00T");
  });

  it("formats small decimals", () => {
    expect(formatCompact(0.123)).toBe("0.12");
  });

  it("formats negative numbers below 1000", () => {
    // formatCompact doesn't handle negatives specially, so it falls through
    expect(formatCompact(-500)).toBe("-500.00");
  });
});
