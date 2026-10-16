// @vitest-environment node
/** v2.2 QA copy round: stake 19 / 21, wrapper 22, and the bounded wait for a refusal that never clears (Q-7). */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { WaitExhaustedError, waitBudgetSpent } from "@/lib/tx";
import { TRADE_WAIT_BUDGET_MS } from "@/lib/limits/price-stall";

const ids = resolveDevnetProgramIds();
const fail = (program: string, code: number) => new Error(`Simulation failed: Program ${program} failed: custom program error: 0x${code.toString(16)}`);

describe("copy round", () => {
  afterEach(() => __setDevnetV22ForTest(null));

  it("stake 19 (TrancheNotEnabled) and 21 (WrongTranche) are clear one-liners, not 'Something went wrong'", () => {
    __setDevnetV22ForTest(true);
    const a = resolveUserMessage(fail(ids.stake, 19), { surface: "stake" });
    const b = resolveUserMessage(fail(ids.stake, 21), { surface: "stake" });
    expect(a.kind).toBe("stake-no-tiers");
    expect(b.kind).toBe("stake-wrong-tier");
    expect(b.body).toBe("This wallet already has a deposit in the other tier of this pool. Use that tier, or another wallet. Nothing was sent.");
    for (const m of [a, b]) expect(m.body).not.toMatch(/something went wrong/i);
  });

  it("a WRAPPER 19 / 21 is not read through the stake table", () => {
    __setDevnetV22ForTest(true);
    expect(resolveUserMessage(fail(ids.wrapper, 19), { surface: "trade" }).kind).toBe("engine-catching-up");
    expect(resolveUserMessage(fail(ids.wrapper, 21), { surface: "trade" }).kind).not.toBe("stake-wrong-tier");
  });

  it("wrapper 22 (EngineNonProgress): nothing to do", () => {
    const m = resolveUserMessage(fail(ids.wrapper, 22), { surface: "any" });
    expect(m.kind).toBe("nothing-to-do");
    expect(m.body).toBe("Nothing to do right now: this is already up to date. Nothing was sent.");
  });

  it("Q-7: the wait is bounded (2 min on the v2.2 ticket) and ends with a clear line, not 'goes through automatically'", () => {
    expect(waitBudgetSpent(119_999, TRADE_WAIT_BUDGET_MS)).toBe(false);
    expect(waitBudgetSpent(120_000, TRADE_WAIT_BUDGET_MS)).toBe(true);
    expect(waitBudgetSpent(10 ** 9, undefined)).toBe(false);
    const m = resolveUserMessage(new WaitExhaustedError(fail(ids.wrapper, 19)), { surface: "trade" });
    expect(m.kind).toBe("wait-exhausted");
    expect(m.body).toBe("This order still can't go through after waiting, so nothing was sent. Try again later.");
    expect(m.autoRetry).toBeFalsy();
    const tx = readFileSync(path.join(__dirname, "../../../lib/tx.ts"), "utf8");
    expect(tx).toMatch(/if \(waitBudgetSpent\(waited, maxWaitMs\)\) \{\s+onWaiting\?\.\(false\);\s+throw new WaitExhaustedError\(e\);/);
    const ticket = readFileSync(path.join(__dirname, "../../../components/trade/OrderTicket.tsx"), "utf8");
    expect(ticket).toContain("maxWaitMs: waitBudgetMs");
  });
});
