/** Product review 2026-10-28 (S-5 / S-6 / S-12): stake 3 / 8 / 9 read as plain lines on v2.2, not "Something went wrong". */
import { afterEach, describe, expect, it } from "vitest";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const ids = resolveDevnetProgramIds();
const fail = (program: string, code: number) => new Error(`Simulation failed: Program ${program} failed: custom program error: 0x${code.toString(16)}`);

describe("stake errors the stake page can hit", () => {
  afterEach(() => __setDevnetV22ForTest(null));
  it.each([
    [3, "stake-cooldown", /cooldown hasn't ended yet/],
    [8, "stake-market-settled", /has settled, so its pool takes no new deposits/],
    [9, "stake-cap", /deposits are closed while the market is being settled/],
  ])("stake %i is a plain line", (code, kind, re) => {
    __setDevnetV22ForTest(true);
    const m = resolveUserMessage(fail(ids.stake, code), { surface: "stake" });
    expect(m.kind).toBe(kind);
    expect(m.body).toMatch(re);
    expect(m.body).toMatch(/Nothing was sent/);
    expect(m.body).not.toMatch(/something went wrong/i);
  });
  it("the same codes from the WRAPPER are not read as stake codes", () => {
    __setDevnetV22ForTest(true);
    expect(resolveUserMessage(fail(ids.wrapper, 9), { surface: "trade" }).kind).not.toBe("stake-cap");
  });
});

describe("launch copy (product review M-3 / M-5 / M-14)", () => {
  it("the missing-guard block says what happens on mainnet, the init-failure line no longer claims nothing else changed", async () => {
    const { LEV_GUARD_MISSING_BLOCK, LEV_GUARD_INIT_FAILED } = await import("@/lib/v22/lev-guard");
    expect(LEV_GUARD_MISSING_BLOCK).toMatch(/on mainnet nobody can open a position on it until the guard exists/);
    expect(LEV_GUARD_INIT_FAILED).not.toMatch(/Nothing else was changed/);
  });
  it("the shallow-pool line no longer asks the creator to pick a pool (the wizard has no pool picker)", async () => {
    const { BELOW_LIQUIDITY_FLOOR_REASON } = await import("@/lib/dex-constants");
    expect(BELOW_LIQUIDITY_FLOOR_REASON).not.toMatch(/Pick a deeper pool/);
  });
});
