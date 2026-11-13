// @vitest-environment node
/**
 * The trades panel reported "Fees Paid: 0" for a trader who had paid a fee on
 * every fill.
 *
 * `trades.fee` is 0 on every row by design — the indexer's fee extraction is
 * deliberately neutered (#153) — so summing it always yields 0, and the panel
 * presented that as a fact. Volume has the same shape: trades with no recorded
 * price contribute nothing, so the headline understates by whole trades.
 *
 * See lib/trade-stats-display.ts.
 */

import { describe, expect, it } from "vitest";
import {
  feesPaidDisplay,
  volumeDisplay,
  volumeNote,
} from "@/lib/trade-stats-display";

describe("fees: unrecorded is not zero", () => {
  it("reports unrecorded when trades exist but no fee was captured", () => {
    // THE BUG, as reported: 4 trades, every fee row 0, panel showed "0".
    expect(feesPaidDisplay(4, 0, "0")).toEqual({ kind: "unrecorded" });
  });

  it("CONTROL: reports a real total once any fee is recorded", () => {
    // Load-bearing. "Always say unrecorded" would be just as wrong in the
    // other direction, and would never recover after a backfill runs.
    expect(feesPaidDisplay(4, 4, "1500000")).toEqual({
      kind: "known",
      atoms: "1500000",
    });
    // Even a partial backfill flips it to a real figure rather than hiding it.
    expect(feesPaidDisplay(4, 1, "250000")).toEqual({
      kind: "known",
      atoms: "250000",
    });
  });

  it("says nothing when there are no trades", () => {
    expect(feesPaidDisplay(0, 0, "0")).toEqual({ kind: "no-trades" });
  });

  it("CONTROL: the decision is driven by the COUNT, not the sum", () => {
    // A recorded total that genuinely sums to zero must still read as known —
    // otherwise the rule is just "0 means unknown", which is the same
    // conflation with extra steps.
    expect(feesPaidDisplay(2, 2, "0")).toEqual({ kind: "known", atoms: "0" });
  });
});

describe("volume: partial is not complete", () => {
  it("marks the figure partial when some trades have no price", () => {
    // The reported case: 4 trades, 3 with no price, headline computed from 1.
    const v = volumeDisplay(4, 3, "198385291");
    expect(v).toEqual({
      kind: "partial",
      atoms: "198385291",
      missing: 3,
      total: 4,
    });
    expect(volumeNote(v)).toContain("3 of 4");
  });

  it("refuses the figure entirely when no trade has a price", () => {
    // Summing to 0 across four priceless trades is not "low volume".
    expect(volumeDisplay(4, 4, "0")).toEqual({ kind: "unknown", missing: 4 });
  });

  it("CONTROL: a complete figure is reported plainly, with no caveat", () => {
    // Without this, "warn about missing prices" could degrade into warning
    // always, which trains the reader to ignore it.
    const v = volumeDisplay(4, 0, "198385291");
    expect(v).toEqual({ kind: "complete", atoms: "198385291" });
    expect(volumeNote(v)).toBeUndefined();
  });

  it("CONTROL: a nonsensical missing count cannot exceed the trade count", () => {
    // Guards the note's arithmetic: "5 of 4 trades" would be worse than no
    // caveat at all.
    expect(volumeDisplay(4, 9, "0")).toEqual({ kind: "unknown", missing: 4 });
    expect(volumeDisplay(4, -1, "100")).toEqual({
      kind: "complete",
      atoms: "100",
    });
  });

  it("says nothing when there are no trades", () => {
    expect(volumeDisplay(0, 0, "0")).toEqual({ kind: "no-trades" });
  });
});
