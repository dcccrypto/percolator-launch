/**
 * v2.2 QA (partial fill): the CLIPPED flag of the landed FILL event drives "Partially filled: X of Y".
 * The fixture is a REAL devnet transaction (swordcat open 4gyLCVZG…, read-only getTransaction 2026-10-14):
 * flags 9 (CLIPPED | MATCHER), requested 10,000,000, executed 9,525,082.
 */
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import fx from "../../fixtures/v22-clipped-fill-tx.json";
import { fillEventLogs } from "../../helpers/fill-event-fixture";
import { clippedFillFromLogs, readClippedFill } from "@/lib/v22/clipped-fill";

const WRAPPER = new PublicKey("6kpg2wi7vwkn7E9rvodXSktYRhna8TWjiZrC1dBek6NM");
const SWORDCAT = new PublicKey("6fonYScxUpeN8782wm1DQMPJVZj5vUGXnKg75GTRSBUF");
const OTHER = new PublicKey("11111111111111111111111111111111");

describe("clippedFillFromLogs", () => {
  it("real devnet tx: a clipped open reads executed 9,525,082 of requested 10,000,000", () => {
    expect(clippedFillFromLogs(fx.logMessages, WRAPPER, { market: SWORDCAT })).toEqual({ requestedQ: 10_000_000n, executedQ: 9_525_082n, zero: false });
  });
  it("NEGATIVE: another market's fill, another wrapper id, a failed tx and missing logs are not a clipped fill", () => {
    expect(clippedFillFromLogs(fx.logMessages, WRAPPER, { market: OTHER })).toBeNull();
    expect(clippedFillFromLogs(fx.logMessages, new PublicKey("11111111111111111111111111111112"), { market: SWORDCAT })).toBeNull();
    expect(clippedFillFromLogs(fx.logMessages, WRAPPER, { market: SWORDCAT, succeeded: false })).toBeNull();
    expect(clippedFillFromLogs(null, WRAPPER, { market: SWORDCAT })).toBeNull();
  });
  it("NEGATIVE: an unclipped full fill (flags MATCHER only) is not partial, even if sizes differ", () => {
    const logs = fillEventLogs(WRAPPER, SWORDCAT, [{ flags: 8, requestedQ: 10_000_000n, executedQ: 10_000_000n }]);
    expect(clippedFillFromLogs(logs, WRAPPER, { market: SWORDCAT })).toBeNull();
  });
  it("a short position is read by magnitude; a zero fill is flagged zero", () => {
    expect(clippedFillFromLogs(fillEventLogs(WRAPPER, SWORDCAT, [{ flags: 9, requestedQ: -10_000_000n, executedQ: -4_000_000n }]), WRAPPER, { market: SWORDCAT })).toEqual({ requestedQ: 10_000_000n, executedQ: 4_000_000n, zero: false });
    expect(clippedFillFromLogs(fillEventLogs(WRAPPER, SWORDCAT, [{ flags: 13, requestedQ: 3_000_000n, executedQ: 0n }]), WRAPPER, { market: SWORDCAT })?.zero).toBe(true);
  });
});

describe("readClippedFill", () => {
  it("retries a read that is not there yet, then returns the clipped fill", async () => {
    const getTransaction = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ meta: { err: null, logMessages: fx.logMessages } });
    const r = await readClippedFill({ getTransaction } as never, fx.sig, WRAPPER, { market: SWORDCAT }, async () => {});
    expect(r?.executedQ).toBe(9_525_082n);
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });
  it("gives up quietly (null) when the RPC never answers", async () => {
    const getTransaction = vi.fn().mockRejectedValue(new Error("boom"));
    expect(await readClippedFill({ getTransaction } as never, fx.sig, WRAPPER, { market: SWORDCAT }, async () => {}, 3)).toBeNull();
    expect(getTransaction).toHaveBeenCalledTimes(3);
  });
});
