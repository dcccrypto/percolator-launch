import { beforeEach, describe, expect, it } from "vitest";
import { __resetChainSyncHoldsForTests, chainSyncHeld, holdChainSync, setChainSyncHold } from "@/lib/entry-chain-hold";

const S = "slab1";
const T = 10_000_000;
const HOUR = 3_600_000;
beforeEach(() => __resetChainSyncHoldsForTests());

describe("entry-chain-hold", () => {
  it("holds for ms then expires", () => {
    holdChainSync(S, 1000, T);
    expect(chainSyncHeld(S, T + 999)).toBe(true);
    expect(chainSyncHeld(S, T + 1000)).toBe(false);
  });
  it("a backwards clock step cannot extend a hold beyond its own length", () => {
    holdChainSync(S, 12 * 60_000, T);
    const back = T - HOUR;
    expect(chainSyncHeld(S, back)).toBe(true); // first read after the step pulls the expiry to back + 12 min
    expect(chainSyncHeld(S, back + 12 * 60_000 + 1)).toBe(false);
  });
  it("after a backwards step the next trade's hold is not pinned to the stale future stamp", () => {
    holdChainSync(S, 12 * 60_000, T);
    const back = T - HOUR;
    holdChainSync(S, 60_000, back);
    setChainSyncHold(S, 30_000, back + 5); // the end of the trade shortens it
    expect(chainSyncHeld(S, back + 30_006)).toBe(false);
  });
  it("non-finite ms is ignored (never permanent) and does not clobber a real hold", () => {
    holdChainSync(S, Infinity, T);
    expect(chainSyncHeld(S, T + 1)).toBe(false);
    holdChainSync(S, NaN, T);
    expect(chainSyncHeld(S, T + 1)).toBe(false);
    holdChainSync(S, 1000, T);
    setChainSyncHold(S, NaN, T);
    expect(chainSyncHeld(S, T + 1)).toBe(true);
  });
  it("setChainSyncHold(0) releases", () => {
    holdChainSync(S, 1000, T);
    setChainSyncHold(S, 0, T);
    expect(chainSyncHeld(S, T)).toBe(false);
  });
});
