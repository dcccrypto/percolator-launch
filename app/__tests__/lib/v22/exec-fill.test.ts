/**
 * M7: the price a fill EXECUTED at is the wrapper's FILL event `price_e6` (the price the position was booked at), never the
 * oracle / mark the ticket showed. Fixture: a REAL devnet FILL (v22-clipped-fill-tx.json): booked 26.999002, matcher quote 27.115098.
 */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import fx from "../../fixtures/v22-clipped-fill-tx.json";
import { fillEventLogs } from "../../helpers/fill-event-fixture";
import { execFillFromLogs, readExecFill, slippageVsReferenceBps } from "@/lib/v22/exec-fill";

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const SWORDCAT = new PublicKey("6fonYScxUpeN8782wm1DQMPJVZj5vUGXnKg75GTRSBUF");
const OTHER = new PublicKey("11111111111111111111111111111111");

describe("execFillFromLogs", () => {
  it("real devnet tx: reads the BOOKED price (not the matcher quote) and the executed size", () => {
    const f = execFillFromLogs(fx.logMessages, WRAPPER, { market: SWORDCAT });
    expect(f).toEqual({ priceE6: 26_999_002n, executedQ: 9_525_082n, feeAtoms: 2_545_961n });
  });
  it("a short fill keeps its sign; the price is still the booked price", () => {
    const logs = fillEventLogs(WRAPPER, SWORDCAT, [{ flags: 8, requestedQ: -2_000_000n, executedQ: -2_000_000n, priceE6: 89_741_672n, quotedPriceE6: 89_000_000n }]);
    expect(execFillFromLogs(logs, WRAPPER, { market: SWORDCAT })).toMatchObject({ priceE6: 89_741_672n, executedQ: -2_000_000n });
  });
  it("several legs of one batch average by executed size; zero-size records do not count", () => {
    const logs = fillEventLogs(WRAPPER, SWORDCAT, [
      { flags: 8, requestedQ: 1_000_000n, executedQ: 1_000_000n, priceE6: 90_000_000n },
      { flags: 8, requestedQ: 3_000_000n, executedQ: 3_000_000n, priceE6: 94_000_000n },
      { flags: 12, requestedQ: 5_000_000n, executedQ: 0n, priceE6: 1n },
    ]);
    expect(execFillFromLogs(logs, WRAPPER, { market: SWORDCAT })?.priceE6).toBe(93_000_000n);
  });
  it("NEGATIVE: another market, another wrapper, a failed tx, missing logs, an all-zero fill: null", () => {
    expect(execFillFromLogs(fx.logMessages, WRAPPER, { market: OTHER })).toBeNull();
    expect(execFillFromLogs(fx.logMessages, new PublicKey("11111111111111111111111111111112"), { market: SWORDCAT })).toBeNull();
    expect(execFillFromLogs(fx.logMessages, WRAPPER, { market: SWORDCAT, succeeded: false })).toBeNull();
    expect(execFillFromLogs(null, WRAPPER, { market: SWORDCAT })).toBeNull();
    expect(execFillFromLogs(fillEventLogs(WRAPPER, SWORDCAT, [{ flags: 12, requestedQ: 1n, executedQ: 0n }]), WRAPPER, { market: SWORDCAT })).toBeNull();
  });
  it("two assets in one tx and no asset named: ambiguous, null; with the asset named: that asset's price", () => {
    const logs = fillEventLogs(WRAPPER, SWORDCAT, [
      { flags: 8, requestedQ: 1_000_000n, executedQ: 1_000_000n, priceE6: 90_000_000n, assetIndex: 0 },
      { flags: 8, requestedQ: 1_000_000n, executedQ: 1_000_000n, priceE6: 5_000_000n, assetIndex: 1 },
    ]);
    expect(execFillFromLogs(logs, WRAPPER, { market: SWORDCAT })).toBeNull();
    expect(execFillFromLogs(logs, WRAPPER, { market: SWORDCAT, assetIndex: 1 })?.priceE6).toBe(5_000_000n);
  });
});

describe("readExecFill", () => {
  it("retries a read that is not there yet", async () => {
    const getTransaction = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ meta: { err: null, logMessages: fx.logMessages } });
    const r = await readExecFill({ getTransaction } as never, fx.sig, WRAPPER, { market: SWORDCAT }, async () => {});
    expect(r?.priceE6).toBe(26_999_002n);
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });
  it("null (unknown) when the RPC never answers: never a guess", async () => {
    const getTransaction = vi.fn().mockRejectedValue(new Error("boom"));
    expect(await readExecFill({ getTransaction } as never, "sigX", WRAPPER, { market: SWORDCAT }, async () => {}, 3)).toBeNull();
  });
});

describe("slippageVsReferenceBps", () => {
  it("SOL long from the council trace: booked 89.741672 vs reference 89.535739 is +23 bps against a buyer", () => {
    expect(slippageVsReferenceBps(89_741_672n, 89_535_739n, true)).toBe(23);
  });
  it("sign is the COST to the trader: a sell below the reference is positive", () => {
    expect(slippageVsReferenceBps(89_311_989n, 89_500_000n, false)).toBe(21);
    expect(slippageVsReferenceBps(89_700_000n, 89_500_000n, false)).toBe(-22);
  });
  it("no reference: null", () => {
    expect(slippageVsReferenceBps(1n, 0n, true)).toBeNull();
  });
});
