/** Locks the attribution rules of lib/limits/user-message.ts: a Custom(n) is decoded by the program that raised it, and earn 25/91 depend on the surface. */
import { afterEach, describe, expect, it } from "vitest";
import { resolveUserMessage, parseFailure } from "@/lib/limits/user-message";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const ids = resolveDevnetProgramIds();
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const fail = (pid: string, code: number) => `Program ${pid} failed: custom program error: 0x${code.toString(16)}`;
const err = (logs: string[], code: number) => Object.assign(new Error(`Transaction simulation failed: {"InstructionError":[1,{"Custom":${code}}]}`), { logs });

describe("user-message attribution", () => {
  afterEach(() => __setDevnetV22ForTest(null));

  it("a CPI callee's code is never read as a wrapper code (token program Custom(1) is not InvalidVersion)", () => {
    const u = resolveUserMessage(err([fail(TOKEN, 1), fail(ids.wrapper, 1)], 1), { surface: "trade" });
    expect(u.details.programId).toBe(TOKEN);
    expect(u.details.name).toBeNull();
    expect(u.kind).toBe("unmapped");
  });

  it("matcher 8002 is a price wait; the same number from the wrapper is not", () => {
    expect(resolveUserMessage(err([fail(ids.matcher, 8002), fail(ids.wrapper, 8002)], 8002), { surface: "trade" }).kind).toBe("price-wait");
    expect(resolveUserMessage(err([fail(ids.wrapper, 8002)], 8002), { surface: "trade" }).kind).toBe("unmapped");
  });

  it("the stake program's Custom(21) is not wrapper EngineLockActive", () => {
    __setDevnetV22ForTest(true);
    const u = resolveUserMessage(err([fail(ids.stake, 21), fail(ids.wrapper, 21)], 21), { surface: "stake" });
    expect(u.kind).not.toBe("engine-catching-up");
    expect(u.details.name).toBeNull();
  });

  it("hex, JSON and paren forms agree", () => {
    expect(parseFailure("custom program error: 0x19").code).toBe(25);
    expect(parseFailure('{"InstructionError":[0,{"Custom":25}]}').code).toBe(25);
    expect(parseFailure("Custom(25)").code).toBe(25);
  });

  const wrapperErr = (code: number) => err([fail(ids.wrapper, code)], code);
  it("25 is withdraw copy only on earn-withdraw, deposit copy only on earn-deposit, generic elsewhere", () => {
    expect(resolveUserMessage(wrapperErr(WRAPPER_ERR.EngineCounterUnderflow), { surface: "earn-withdraw" }).kind).toBe("earn-payout-split");
    expect(resolveUserMessage(wrapperErr(WRAPPER_ERR.EngineCounterUnderflow), { surface: "earn-deposit" }).kind).toBe("earn-deposit-settling");
    expect(resolveUserMessage(wrapperErr(WRAPPER_ERR.EngineCounterUnderflow), { surface: "trade" }).kind).toBe("unmapped");
  });

  it("91 on a withdrawal never says deposits are paused", () => {
    const w = resolveUserMessage(wrapperErr(WRAPPER_ERR.LpVaultTargetPotImpaired), { surface: "earn-withdraw" });
    expect(w.kind).toBe("earn-withdraw-retry");
    expect(`${w.title} ${w.body}`).not.toMatch(/deposit/i);
    expect(resolveUserMessage(wrapperErr(WRAPPER_ERR.LpVaultTargetPotImpaired), { surface: "earn-deposit" }).kind).toBe("earn-pot-impaired");
  });
});
