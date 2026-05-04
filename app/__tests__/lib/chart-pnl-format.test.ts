import { describe, it, expect } from "vitest";
import { formatPnl } from "../../lib/chart-pnl-format";

describe("formatPnl", () => {
  it("classifies a profit as 'positive' and prepends + signs", () => {
    const r = formatPnl(120.5, 8.4);
    expect(r.sign).toBe("positive");
    expect(r.display).toBe("+$120.50 (+8.40%)");
  });

  it("classifies a loss as 'negative' and prepends - signs", () => {
    const r = formatPnl(-15, -1.234);
    expect(r.sign).toBe("negative");
    expect(r.display).toBe("-$15.00 (-1.23%)");
  });

  it("classifies an exact zero as 'zero' with no leading sign", () => {
    const r = formatPnl(0, 0);
    expect(r.sign).toBe("zero");
    expect(r.display).toBe("$0.00 (0.00%)");
  });

  it("rounds to two decimal places (USD and percent)", () => {
    expect(formatPnl(1.2349, 3.4567).display).toBe("+$1.23 (+3.46%)");
  });

  it("preserves a sub-cent loss as 'negative' even when USD rounds to $0.00", () => {
    // A position with a tiny mark-to-market loss should NOT render green —
    // the sign tracks the input value, not the rounded display.
    const r = formatPnl(-0.001, -0.01);
    expect(r.sign).toBe("negative");
    expect(r.display).toBe("-$0.00 (-0.01%)");
  });

  it("preserves a sub-cent profit as 'positive'", () => {
    const r = formatPnl(0.001, 0.01);
    expect(r.sign).toBe("positive");
    expect(r.display).toBe("+$0.00 (+0.01%)");
  });

  it("handles large values without scientific notation or commas", () => {
    // toFixed(2) is intentional — no thousands separators on the chart badge
    // (matches existing PositionPanel formatting; commas would compete with
    // the live-price ticker font density).
    expect(formatPnl(12345.67, 250.5).display).toBe("+$12345.67 (+250.50%)");
  });

  it("does not double-sign when the negative input already produces a minus", () => {
    // Math.abs in the formatter is the load-bearing guard against "--$15.00".
    const r = formatPnl(-50.25, -7.5);
    expect(r.display).not.toContain("--");
    expect(r.display).toBe("-$50.25 (-7.50%)");
  });
});
