import { describe, it, expect, afterEach } from "vitest";
import { healthBadges } from "@/lib/market-health";
import type { MarketHealth } from "@/lib/market-health";
import { __setMoveFlowForTest } from "@/lib/v21/move/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";

const dead = { lockReasons: ["recovery"] } as unknown as MarketHealth;
const detail = (): string => {
  const b = healthBadges(dead).find((x) => x.id === "v1");
  if (!b) throw new Error("v1 badge missing");
  return b.detail;
};

afterEach(() => {
  __setMoveFlowForTest(null);
  __setDevnetV21ForTest(null);
});

describe("v1 close-only badge copy (market-health)", () => {
  it("flag on: says deposits and margin are paused and what stays open", () => {
    __setDevnetV21ForTest(true);
    __setMoveFlowForTest(true);
    const d = detail();
    expect(d).toMatch(/margin and deposits/);
    expect(d).toMatch(/Withdraw, close, claim and Earn exit stay open/);
  });
  it("NEGATIVE CONTROL: flag off keeps the original copy exactly", () => {
    __setDevnetV21ForTest(true);
    __setMoveFlowForTest(false);
    expect(detail()).toBe(
      "This is a v1 market and it is close-only for now: you can close positions and withdraw, but not open new ones.",
    );
  });
});
