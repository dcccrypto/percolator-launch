import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { assertV1AllowsNewFunds, v1BlocksNewFunds, V1_CLOSE_ONLY_REFUSAL } from "@/lib/v21/move/close-only";
import { __setMoveFlowForTest } from "@/lib/v21/move/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { V1_PROGRAM_IDS } from "@/lib/v21/move/ids";
import { MOVE_COPY } from "@/lib/v21/move/copy";
import { pk } from "./fixtures";

const V1 = V1_PROGRAM_IDS.wrapper;
afterEach(() => {
  __setMoveFlowForTest(null);
  __setDevnetV21ForTest(null);
});
const on = () => {
  __setDevnetV21ForTest(true);
  __setMoveFlowForTest(true);
};

describe("M-2: v1 takes no new money while Move is on", () => {
  it("predicate: v1 + flag blocks; v2.1/unknown program and flag off do not", () => {
    expect(v1BlocksNewFunds(V1, true)).toBe(true);
    expect(v1BlocksNewFunds(V1, false)).toBe(false);
    expect(v1BlocksNewFunds(pk(), true)).toBe(false);
    expect(v1BlocksNewFunds(null, true)).toBe(false);
  });

  it.each(["deposit", "add-margin", "earn-deposit", "first-trade"] as const)("hook-level guard refuses %s on v1 with the flag on, with exact copy", (action) => {
    on();
    expect(() => assertV1AllowsNewFunds(V1, action)).toThrow(V1_CLOSE_ONLY_REFUSAL);
    expect(() => assertV1AllowsNewFunds(new PublicKey(V1), action)).toThrow(/close-only/);
  });

  it("hook-level guard is silent with the flag off, and on a non-v1 program", () => {
    expect(() => assertV1AllowsNewFunds(V1, "deposit")).not.toThrow();
    on();
    expect(() => assertV1AllowsNewFunds(pk(), "deposit")).not.toThrow();
    expect(() => assertV1AllowsNewFunds(null, "deposit")).not.toThrow();
  });

  it("the Move flag alone (v2.1 flag off) blocks nothing", () => {
    __setDevnetV21ForTest(false);
    __setMoveFlowForTest(true);
    expect(() => assertV1AllowsNewFunds(V1, "deposit")).not.toThrow();
  });

  it("copy says exactly what is still possible; the banner says the limit is app-side only", () => {
    expect(V1_CLOSE_ONLY_REFUSAL).toMatch(/close positions, withdraw, collect Earn withdrawals and claim fees/);
    expect(MOVE_COPY.closeOnlyBanner).toMatch(/in the app only/);
  });

  // Wiring: every entry point calls the one predicate (a removed call is caught here).
  const root = join(__dirname, "../../../..");
  const src = (p: string) => readFileSync(join(root, p), "utf8");
  it.each([
    ["hooks/useDeposit.ts", "assertV1AllowsNewFunds("],
    ["hooks/useFirstTrade.ts", "assertV1AllowsNewFunds("],
    ["hooks/useInsuranceLP.ts", "assertV1AllowsNewFunds("],
    ["components/trade/DepositWithdrawCard.tsx", "v1BlocksNewFunds("],
    ["components/trade/PositionPanel.tsx", "v1BlocksNewFunds("],
    ["components/earn/VaultDepositRail.tsx", "v1BlocksNewFunds("],
  ])("%s is wired to the predicate", (file, needle) => {
    expect(src(file)).toContain(needle);
  });
  it("withdraw / close / Earn exit paths are NOT guarded", () => {
    expect(src("hooks/useWithdraw.ts")).not.toContain("assertV1AllowsNewFunds");
    expect(src("hooks/useClosePosition.ts")).not.toContain("assertV1AllowsNewFunds");
  });
});

describe("L-6: no guessing the account index", () => {
  it("the executor host returns null when the user account is not loaded, never index 0", () => {
    const f = readFileSync(join(__dirname, "../../../../components/move/MarketExecutorHost.tsx"), "utf8");
    expect(f).toContain("if (!userAccount) return null;");
    expect(f).not.toMatch(/userAccount\?\.idx \?\? 0/);
  });
});

describe("I-5: the test seam cannot run in production", () => {
  it("throws under NODE_ENV=production", () => {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      expect(() => __setMoveFlowForTest(true)).toThrow(/test-only/);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev ?? "test";
    }
  });
});
