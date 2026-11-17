// @vitest-environment node
/**
 * A user clock that steps BACKWARDS (NTP correction, manual change, VM resume) made `Date.now() - ts` negative:
 * the blockhash / priority-fee caches then looked "fresh" until the clock caught up, and the confirmation poll
 * ran far longer than CONFIRMATION_POLL.maxMs. Also: SimulationRefusal threw on a BigInt-bearing error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ network: "devnet", rpcUrl: "https://api.devnet.solana.com" }),
  getNetwork: () => "devnet",
}));

import { getFreshBlockhash, getPriorityFee, pollConfirmation, SimulationRefusal, CONFIRMATION_POLL } from "@/lib/tx";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

function conn(extra: Record<string, unknown> = {}) {
  return {
    rpcEndpoint: "https://percolator-playground.vercel.app/api/rpc",
    getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10_000_000 }),
    getRecentPrioritizationFees: vi.fn().mockResolvedValue([]),
    getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }),
    ...extra,
  } as never;
}

describe("clock stepping backwards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
    __setDevnetV22ForTest(false); // legacy path: the only one that reuses a cached blockhash
  });
  afterEach(() => {
    __setDevnetV22ForTest(null);
    vi.useRealTimers();
  });

  it("does not reuse a cached blockhash after the clock steps back", async () => {
    const c = conn();
    await getFreshBlockhash(c);
    vi.setSystemTime(new Date("2026-11-17T11:00:00Z")); // -1h
    await getFreshBlockhash(c);
    expect((c as never as { getLatestBlockhash: { mock: { calls: unknown[] } } }).getLatestBlockhash.mock.calls.length).toBe(2);
  });

  it("does not reuse a cached priority fee after the clock steps back", async () => {
    const c = conn();
    await getPriorityFee(c);
    vi.setSystemTime(new Date("2026-11-17T11:00:00Z"));
    await getPriorityFee(c);
    expect((c as never as { getRecentPrioritizationFees: { mock: { calls: unknown[] } } }).getRecentPrioritizationFees.mock.calls.length).toBe(2);
  });

  it("pollConfirmation still times out after ~maxMs of real elapsed time when the clock steps back", async () => {
    const c = conn();
    const p = pollConfirmation(c, "sig").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.setSystemTime(new Date("2026-11-17T10:00:00Z")); // -2h step
    await vi.advanceTimersByTimeAsync(CONFIRMATION_POLL.maxMs + 5_000);
    const r = await p;
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/Confirmation timeout/);
  });
});

describe("SimulationRefusal", () => {
  it("keeps the real error when it carries a BigInt", () => {
    const err = { InstructionError: [0, { Custom: 19 }], unitsConsumed: 5n };
    let refusal: SimulationRefusal | undefined;
    expect(() => { refusal = new SimulationRefusal(err, [], []); }).not.toThrow();
    expect(refusal!.message).toContain("Custom");
    expect(refusal!.message).toContain("5");
  });
});
