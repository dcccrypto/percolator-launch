/**
 * Product review 2026-10-28 (T-1): the ticket's Fee row and the confirm screen show base + matcher quote fee + busy-side fee, not the
 * base fee alone (JUP fills charged ~53 bps against 30 shown; a PENGU open ~2% against 0.30%: v22-qa-issues Q-1 / round b).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { estimatedTotalFeeBps, feeHasExtras } from "@/lib/limits/estimated-fee";

describe("estimatedTotalFeeBps", () => {
  it("no fee channel read: the base fee", () => {
    expect(estimatedTotalFeeBps(30n, null)).toBe(30n);
    expect(feeHasExtras(30n, 30n)).toBe(false);
  });
  it("charged channel: base + the quote fee (JUP: 30 + 23 = 53)", () => {
    expect(estimatedTotalFeeBps(30n, { charged: true, requestedBps: 23n })).toBe(53n);
    expect(feeHasExtras(30n, 53n)).toBe(true);
  });
  it("busy-side open: + the utilisation fee", () => {
    expect(estimatedTotalFeeBps(30n, { charged: true, requestedBps: 25n, utilFeeBps: 150n })).toBe(205n);
  });
  it("a channel that is not charged adds no quote fee, but a busy-side fee still counts", () => {
    expect(estimatedTotalFeeBps(30n, { charged: false, requestedBps: 25n })).toBe(30n);
    expect(estimatedTotalFeeBps(30n, { charged: false, requestedBps: 0n, utilFeeBps: 40n })).toBe(70n);
  });
});

describe("wiring (source-level)", () => {
  const src = (rel: string) => readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");
  it("the ticket's Fee row and the confirm snapshot use the estimate, not the base-rate fee", () => {
    const s = src("components/trade/OrderTicket.tsx");
    expect(s).toContain("estimatedTotalFeeBps(tradingFeeBps, ticketLimits.fee)");
    expect(s).toMatch(/value=\{`\$\{formatTokenAmount\(estFee, decimals\)\} \$\{collateralSymbol\}`\}/);
    expect(s).toContain("tradingFee: estFee,");
    expect(s).not.toContain("tradingFee: fee,");
  });
  it("the confirm screen marks an estimate", () => {
    expect(src("components/trade/TradeConfirmationModal.tsx")).toContain('"Trading Fee (est.):"');
  });
});
