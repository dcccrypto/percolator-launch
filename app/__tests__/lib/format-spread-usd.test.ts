/**
 * The Market Stats spread read "+$— (+0.00%)" whenever mark equalled index: it formatted the
 * absolute spread with formatUsd, which reads 0 as "no price" ("$—"), then spliced the sign in.
 * formatSpreadUsd treats 0 as a real zero spread.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatSpreadUsd, formatUsd } from "@/lib/format";

describe("formatSpreadUsd", () => {
  it("an exact match is $0.00, unsigned", () => {
    expect(formatSpreadUsd(0n)).toBe("$0.00");
  });

  it("signs a real spread and formats it like a price", () => {
    expect(formatSpreadUsd(60_000n)).toBe("+$0.06");
    expect(formatSpreadUsd(-60_000n)).toBe("−$0.06");
    expect(formatSpreadUsd(1n)).toBe(`+${formatUsd(1n)}`);
  });

  it("CONTROL: formatUsd itself still reads 0 as no price", () => {
    expect(formatUsd(0n)).toBe("$—");
  });
});

describe("MarketStatsCard spread", () => {
  const src = readFileSync(join(__dirname, "..", "..", "components/trade/MarketStatsCard.tsx"), "utf8");

  it("uses formatSpreadUsd and an unsigned 0.00% for a zero spread", () => {
    expect(src).toContain("formatSpreadUsd(spreadAbs)");
    expect(src).toContain('spreadBps === 0 ? "0.00%"');
    expect(src).not.toMatch(/formatUsd\(absSpread\)\.replace/);
  });
});
