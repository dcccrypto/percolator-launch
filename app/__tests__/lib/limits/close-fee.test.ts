/**
 * #3726: every close preview showed the base trading fee only. On a fee-channel market the program charges a close base + the matcher's
 * requested fee as well (the matcher attaches the request on every filled leg, no reduce exemption), but no busy-side fee (growth_v19.rs).
 * On devnet a 1,777 USDC close previewed 5.33 USDC and was charged 12.62. `closeFeeBps` is the close previews' estimate.
 */
import { describe, expect, it, vi } from "vitest";
import { closeFeeBps } from "@/lib/limits/estimated-fee";
import { deriveTicketLimits, type TicketLimitsInput } from "@/lib/limits/ticket";
import { ALL_ON, OWNER_A, marketLimits } from "./fixtures";

const USD = 1_000_000n;
const base0 = marketLimits();
// Same fee-channel fixture as gate-fee.test.ts: a kind-1 matcher bound of 60 bps is charged on top of the base.
const charged = marketLimits({
  matcher: { ...base0.matcher!, kind: 1, v2: undefined, maxTotalBps: 60 },
  flags: { ...ALL_ON, p2FeeCharged: true },
  riskLimits: { sideOiCapQ: 0n, lpFloorAtoms: 0n, lpExposureKBps: 0, execBandBps: 0, matcherExtMode: 1, maxRequestedFeeBps: 100, allDefault: false },
});
const uncharged = marketLimits();
/** Closing a 50-unit long: the close trades the SHORT side, from a +50 position. */
const closeOfLong = (limits = charged, sizeQ = 50n * USD): TicketLimitsInput => ({
  limits, direction: "short", sizeQ, takerPosQ: 50n * USD, takerOwner: OWNER_A, leverage: 1, limitPriceE6: 0n,
});

describe("closeFeeBps", () => {
  it("fee-channel market: the close is charged base + the matcher's requested fee", () => {
    const fee = deriveTicketLimits(closeOfLong()).fee;
    expect(fee?.charged).toBe(true);
    expect(fee!.requestedBps).toBe(60n);
    expect(closeFeeBps(10n, closeOfLong())).toBe(70n);
  });

  it("a partial close is estimated on its own size", () => {
    expect(closeFeeBps(10n, closeOfLong(charged, 10n * USD))).toBe(70n);
  });

  it("closing a short (the close trades the long side) is charged the same way", () => {
    const closeOfShort: TicketLimitsInput = { ...closeOfLong(), direction: "long", takerPosQ: -50n * USD };
    expect(closeFeeBps(10n, closeOfShort)).toBe(70n);
  });

  it("CONTROL: a market that does not charge the quote is the base fee alone (the 28 channel-off devnet closes)", () => {
    expect(closeFeeBps(10n, closeOfLong(uncharged))).toBe(10n);
  });

  it("CONTROL: no input, a zero size, or a failing read is the base fee (the previous behaviour)", () => {
    expect(closeFeeBps(10n, null)).toBe(10n);
    expect(closeFeeBps(10n, closeOfLong(charged, 0n))).toBe(10n);
    expect(closeFeeBps(10n, { ...closeOfLong(), limits: null as unknown as TicketLimitsInput["limits"] })).toBe(10n);
  });
});

describe("closeFeeBps leaves out the busy-side fee, which a close is not charged", () => {
  it("a growth market's utilisation fee is not added to a close", async () => {
    vi.resetModules();
    vi.doMock("@/lib/limits/ticket", async (orig) => ({
      ...(await orig<object>()),
      deriveTicketLimits: () => ({ fee: { charged: true, requestedBps: 25n, utilFeeBps: 150n } }),
    }));
    const { closeFeeBps: fresh } = await import("@/lib/limits/estimated-fee");
    const { estimatedTotalFeeBps } = await import("@/lib/limits/estimated-fee");
    expect(fresh(30n, closeOfLong())).toBe(55n); // base + requested, no utilisation
    // CONTROL: the open-side estimate over the same read DOES add it.
    expect(estimatedTotalFeeBps(30n, { charged: true, requestedBps: 25n, utilFeeBps: 150n })).toBe(205n);
    vi.doUnmock("@/lib/limits/ticket");
  });
});
