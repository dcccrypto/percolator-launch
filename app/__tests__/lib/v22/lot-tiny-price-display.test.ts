import { describe, expect, it } from "vitest";
import { formatUsdFromNumber, formatUsdPriceE6 } from "@/lib/format";
import { formatLotPriceE6, formatLotQ, lotPriceToTokenE6 } from "@/lib/v22/lot";
import { resolveDiscoveredPriceUsd } from "@/lib/discovered-price";
import { markToTokenUsd, qToDisplayTokens } from "@/lib/v22/lot-view";

// tiny-price format (prog #711): price is quote-E6 per 10^lot_exp tokens, so a $3e-7 token at lot_exp 6 is 300_000.
describe("tiny per-token price display (lot_exp)", () => {
  it("BEFORE: the per-token e6 integer floors to zero", () => {
    expect(lotPriceToTokenE6(300_000n, 6)).toBe(0n);
    expect(formatUsdPriceE6(lotPriceToTokenE6(300_000n, 6))).toBe("—");
  });

  it("AFTER: a non-default lot market shows a non-zero per-token price", () => {
    expect(formatLotPriceE6(300_000n, 6)).toBe("$0.0000003");
    expect(markToTokenUsd(300_000n, 6)).toBeCloseTo(3e-7, 15);
    expect(formatUsdFromNumber(3e-7)).toBe("$0.0000003");
  });

  it("size is consistent: 5 lots at lot_exp 6 is 5,000,000 tokens", () => {
    expect(qToDisplayTokens(5_000_000n, 6)).toBe(5_000_000);
    expect(formatLotQ(5_000_000n, 6, 6)).toBe("5000000");
  });

  it("discovered market keeps a price instead of reading as no oracle", () => {
    const oc = { configV17: { markEwmaE6: 300_000n, invert: 0 } } as never;
    expect(resolveDiscoveredPriceUsd(oc, 6)).toBeCloseTo(3e-7, 15);
    expect(resolveDiscoveredPriceUsd(oc, null)).toBeNull();
  });

  it("default scale is unchanged", () => {
    expect(formatLotPriceE6(81_166_378n, 0)).toBe(formatUsdPriceE6(81_166_378n));
    expect(formatLotPriceE6(0n, 0)).toBe("—");
    expect(formatUsdFromNumber(81.166378)).toBe("$81.166378");
    expect(formatUsdFromNumber(0.000001)).toBe("$0.000001");
    expect(formatUsdFromNumber(null)).toBe("—");
    const oc = { configV17: { markEwmaE6: 2_573_000n, invert: 0 } } as never;
    expect(resolveDiscoveredPriceUsd(oc, 0)).toBe(2.573);
    expect(formatLotQ(1_500_000n, 6, 0)).toBe("1.5");
  });
});
