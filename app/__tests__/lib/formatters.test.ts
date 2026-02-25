import { describe, it, expect } from "vitest";
import { formatCompact } from "../../lib/formatters";

describe("formatCompact", () => {
  it("formats trillions", () => {
    expect(formatCompact(1.5e12)).toBe("1.50T");
  });

  it("formats billions", () => {
    expect(formatCompact(2.3e9)).toBe("2.30B");
  });

  it("formats millions", () => {
    expect(formatCompact(5.67e6)).toBe("5.67M");
  });

  it("formats thousands", () => {
    expect(formatCompact(1234)).toBe("1.23K");
  });

  it("formats small numbers as-is", () => {
    expect(formatCompact(999)).toBe("999.00");
  });

  it("formats zero", () => {
    expect(formatCompact(0)).toBe("0.00");
  });

  it("formats exactly 1000 as K", () => {
    expect(formatCompact(1000)).toBe("1.00K");
  });

  it("formats exactly 1e6 as M", () => {
    expect(formatCompact(1e6)).toBe("1.00M");
  });

  it("formats exactly 1e9 as B", () => {
    expect(formatCompact(1e9)).toBe("1.00B");
  });

  it("formats exactly 1e12 as T", () => {
    expect(formatCompact(1e12)).toBe("1.00T");
  });

  it("formats fractional numbers", () => {
    expect(formatCompact(0.5)).toBe("0.50");
  });
});
