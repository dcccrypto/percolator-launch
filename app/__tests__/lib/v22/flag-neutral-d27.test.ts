// @vitest-environment node
/**
 * D27: the v2.2 switch is cluster-neutral (`NEXT_PUBLIC_V22`), with `NEXT_PUBLIC_DEVNET_V22` kept as a fallback (Vercel env cannot be changed
 * for the preview), and a growth launch with no guard step is refused on mainnet.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDevnetV22ForTest, isDevnetV22Enabled } from "@/lib/v22/flag";
import { LEV_GUARD_PLAN_MISSING, levGuardApplies, levGuardPlanBlock } from "@/lib/v22/lev-guard";

describe("flag: NEXT_PUBLIC_V22 with NEXT_PUBLIC_DEVNET_V22 fallback", () => {
  const saved = { a: process.env.NEXT_PUBLIC_V22, b: process.env.NEXT_PUBLIC_DEVNET_V22 };
  beforeEach(() => {
    __setDevnetV22ForTest(null);
    delete process.env.NEXT_PUBLIC_V22;
    delete process.env.NEXT_PUBLIC_DEVNET_V22;
  });
  afterEach(() => {
    for (const [k, v] of [["NEXT_PUBLIC_V22", saved.a], ["NEXT_PUBLIC_DEVNET_V22", saved.b]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  it("NEXT_PUBLIC_V22=1 / true turns it on with the old variable unset", () => {
    process.env.NEXT_PUBLIC_V22 = "1";
    expect(isDevnetV22Enabled()).toBe(true);
    process.env.NEXT_PUBLIC_V22 = "true";
    expect(isDevnetV22Enabled()).toBe(true);
  });
  it("the old NEXT_PUBLIC_DEVNET_V22=1 still turns it on (preview keeps working unchanged)", () => {
    process.env.NEXT_PUBLIC_DEVNET_V22 = "1";
    expect(isDevnetV22Enabled()).toBe(true);
  });
  it("the new variable wins when both are set; an empty new variable is 'unset'", () => {
    process.env.NEXT_PUBLIC_DEVNET_V22 = "1";
    process.env.NEXT_PUBLIC_V22 = "0";
    expect(isDevnetV22Enabled()).toBe(false);
    process.env.NEXT_PUBLIC_V22 = "";
    expect(isDevnetV22Enabled()).toBe(true);
  });
  it("neither set: off", () => {
    expect(isDevnetV22Enabled()).toBe(false);
  });
});

describe("levGuardPlanBlock: a growth launch with no guard step is refused on mainnet", () => {
  const ok = { v22On: true, growth: true, p3: true, network: "mainnet" as const };
  it("mainnet + growth + the guard planned: no block", () => {
    expect(levGuardApplies(ok)).toBe(true);
    expect(levGuardPlanBlock(ok)).toBeNull();
  });
  it("mainnet + growth + v2.2 switch off (the build never plans a guard): blocked, with the message", () => {
    expect(levGuardPlanBlock({ ...ok, v22On: false })).toBe(LEV_GUARD_PLAN_MISSING);
    expect(LEV_GUARD_PLAN_MISSING).toMatch(/NEXT_PUBLIC_V22/);
  });
  it("mainnet + growth + no vault LP: blocked", () => {
    expect(levGuardPlanBlock({ ...ok, p3: false })).toBe(LEV_GUARD_PLAN_MISSING);
  });
  it("NEGATIVE CONTROLS: no growth block, or devnet: never blocked", () => {
    expect(levGuardPlanBlock({ ...ok, v22On: false, growth: false })).toBeNull();
    expect(levGuardPlanBlock({ ...ok, v22On: false, network: "devnet" })).toBeNull();
  });
});
