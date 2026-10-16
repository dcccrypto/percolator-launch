import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ClosePositionForm } from "@/components/trade/ClosePositionForm";
import { availableInWords, catchUpAvailableLine, catchUpEstimate, waitWords } from "@/lib/limits/catchup-estimate";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { bandCatchUpMs, type BandRentView } from "@/lib/v22/band-rent-state";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { WRAPPER_ERR_V22 } from "@/lib/v22/wrapper-errors";
import { WITHDRAW_STALE_MESSAGE } from "@/lib/withdraw-copy";
import { resolveDevnetProgramIds } from "@/lib/program-ids";

beforeEach(() => __setDevnetV22ForTest(true));
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

const ids = resolveDevnetProgramIds();
const fail = (code: number) =>
  new Error(`Transaction simulation failed: Error processing Instruction 2: custom program error: 0x${code.toString(16)}\nProgram ${ids.wrapper} failed: custom program error: 0x${code.toString(16)}`);

const MIN = 60_000;
const LEAD = "The price is still catching up after a big move.";

describe("the wait, in words", () => {
  it("never promises seconds in the 'available in' sentence", () => {
    expect(availableInWords(4_000)).toBe("under a minute");
    expect(availableInWords(59_000)).toBe("under a minute");
    expect(availableInWords(61_000)).toBe("about 2 minutes");
    expect(availableInWords(6 * MIN)).toBe("about 6 minutes");
    expect(availableInWords(45 * MIN)).toBe("about 45 minutes");
    expect(availableInWords(62 * MIN)).toBe("about an hour");
    expect(availableInWords(150 * MIN)).toBe("about 3 hours");
  });
  it("the ticket's waiting line may say seconds only below a minute", () => {
    expect(waitWords(4_000)).toBe("a few seconds");
    expect(waitWords(38_000)).toBe("about 40 seconds");
    expect(waitWords(75_000)).toBe("about 2 minutes");
  });
});

describe("catchUpAvailableLine: close / open / any, with and without an estimate", () => {
  it("close with an estimate", () => {
    expect(catchUpAvailableLine(6 * MIN, "close")).toBe(`${LEAD} Closing is available in about 6 minutes.`);
    expect(catchUpAvailableLine(20_000, "close")).toBe(`${LEAD} Closing is available in under a minute.`);
    expect(catchUpAvailableLine(45 * MIN, "close")).toBe(`${LEAD} Closing is available in about 45 minutes.`);
  });
  it("open with an estimate", () => {
    expect(catchUpAvailableLine(6 * MIN, "open")).toBe(`${LEAD} New positions are available in about 6 minutes.`);
  });
  it("any action (Earn and the like) with an estimate", () => {
    expect(catchUpAvailableLine(6 * MIN, "any")).toBe(`${LEAD} Try again in about 6 minutes.`);
  });
  it("no estimate: 'usually takes a few minutes', never seconds", () => {
    for (const ms of [null, undefined, 0, Number.NaN]) {
      expect(catchUpAvailableLine(ms, "close")).toBe(`${LEAD} Closing reopens when it has; this usually takes a few minutes.`);
      expect(catchUpAvailableLine(ms, "open")).toBe(`${LEAD} New positions reopen when it has; this usually takes a few minutes.`);
      expect(catchUpAvailableLine(ms, "any")).toBe(`${LEAD} This usually takes a few minutes; try again then.`);
    }
  });
});

describe("estimate from the market: gap over the per-slot cap", () => {
  const view = (cap: bigint, mark: bigint, target: bigint): BandRentView =>
    ({ band: { enabled: true }, price: { capBpsPerSlot: cap, markE6: mark, targetE6: target, lagging: true } }) as unknown as BandRentView;
  it("a 20% move at cap 1 takes ~15 min (2,000 slots), at cap 4 about a quarter of that", () => {
    const cap1 = bandCatchUpMs(view(1n, 1_000_000n, 1_200_000n), 400)!;
    expect(cap1 / MIN).toBeGreaterThan(13);
    expect(cap1 / MIN).toBeLessThan(15.5);
    const cap4 = bandCatchUpMs(view(4n, 1_000_000n, 1_200_000n), 400)!;
    expect(cap4).toBeLessThan(cap1 / 3.5);
    expect(catchUpAvailableLine(cap1, "close")).toMatch(/Closing is available in about 14 minutes\.$/);
  });
  it("not lagging, not a band market, or no cap: no estimate", () => {
    expect(bandCatchUpMs(null)).toBeNull();
    expect(bandCatchUpMs({ ...view(1n, 1n, 2n), band: { enabled: false } } as unknown as BandRentView)).toBeNull();
    expect(bandCatchUpMs({ ...view(1n, 1n, 2n), price: { capBpsPerSlot: 1n, markE6: 1n, targetE6: 2n, lagging: false } } as unknown as BandRentView)).toBeNull();
    expect(catchUpEstimate({ effectiveE6: 1_000_000n, targetE6: 1_200_000n, capBpsPerSlot: 0n })).toBeNull();
  });
});

describe("refusals: 21 (engine) and 104 (band pin)", () => {
  it("104 on a close: with an estimate it says when; without, 'usually a few minutes'", () => {
    const withEst = resolveUserMessage(fail(WRAPPER_ERR_V22.PriceBandPinned), { surface: "close", catchUpMs: 6 * MIN });
    expect(withEst.body).toBe(`${LEAD} Closing is available in about 6 minutes.`);
    expect(withEst.title).toBe("Close on hold");
    const none = resolveUserMessage(fail(WRAPPER_ERR_V22.PriceBandPinned), { surface: "close" });
    expect(none.body).toBe(`${LEAD} Closing reopens when it has; this usually takes a few minutes.`);
  });
  it("21 on a close", () => {
    expect(resolveUserMessage(fail(21), { surface: "close", catchUpMs: 20_000 }).body).toBe(`${LEAD} Closing is available in under a minute.`);
    expect(resolveUserMessage(fail(21), { surface: "close" }).body).toBe(`${LEAD} Closing reopens when it has; this usually takes a few minutes.`);
  });
  it("21 on the trade ticket (which waits and resends): the automatic part is said only when the wait fits what the app holds", () => {
    const short = resolveUserMessage(fail(21), { surface: "trade", catchUpMs: 3 * MIN });
    expect(short.body).toBe(`${LEAD} New positions are available in about 3 minutes. Your trade goes through automatically when it's ready.`);
    expect(short.autoRetry).toBe(true);
    const long = resolveUserMessage(fail(21), { surface: "trade", catchUpMs: 45 * MIN });
    expect(long.body).toBe(`${LEAD} New positions are available in about 45 minutes.`);
    expect(long.body).not.toMatch(/automatically/);
    const unknown = resolveUserMessage(fail(21), { surface: "trade" });
    expect(unknown.body).toBe(`${LEAD} New positions reopen when it has; this usually takes a few minutes. Your trade goes through automatically when it's ready.`);
  });
  it("21 on another surface: no 'automatically', no seconds", () => {
    const earn = resolveUserMessage(fail(21), { surface: "any" });
    expect(earn.body).toBe(`${LEAD} This usually takes a few minutes; try again then.`);
    expect(earn.autoRetry).toBeFalsy();
  });
  it("no catch-up line anywhere promises seconds", () => {
    const lines = [
      WITHDRAW_STALE_MESSAGE,
      catchUpAvailableLine(null, "close"),
      catchUpAvailableLine(30_000, "close"),
      resolveUserMessage(fail(21), { surface: "trade" }).body,
      resolveUserMessage(fail(WRAPPER_ERR_V22.PriceBandPinned), { surface: "close", catchUpMs: 4_000 }).body,
    ];
    for (const l of lines) expect(l).not.toMatch(/second/i);
    expect(WITHDRAW_STALE_MESSAGE).toBe(`${LEAD} This usually takes a few minutes; try again then.`);
  });
});

describe("the close form's Catching up note", () => {
  const base = {
    positionSize: 1_000_000n, entryPrice: 1_000_000n, currentPrice: 1_000_000n, capital: 10_000_000n, symbol: "TOK", decimals: 6, priceUsd: 1,
    isLong: true, loading: false, engineCatchingUp: true, onConfirm: () => {},
  } as const;
  it("shows the computed wait, or the generic line", () => {
    const { rerender } = render(<ClosePositionForm {...base} catchUpMs={6 * MIN} />);
    expect(screen.getByTestId("close-catching-up")).toHaveTextContent(`${LEAD} Closing is available in about 6 minutes.`);
    rerender(<ClosePositionForm {...base} />);
    expect(screen.getByTestId("close-catching-up")).toHaveTextContent(`${LEAD} Closing reopens when it has; this usually takes a few minutes.`);
  });
});
