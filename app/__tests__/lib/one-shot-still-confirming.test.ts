/**
 * GH#2953 review: the one-shot rewrite ("Nothing was sent. Try again in a moment.") is only true
 * for PRE-SEND waits. A fund-and-trade whose confirmation timed out WAS broadcast and may still
 * land; telling the user nothing was sent invites a second deposit+trade (double deposit, double
 * position). Its line must stay "Still confirming…".
 */
import { describe, expect, it } from "vitest";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { resolveDevnetProgramIds } from "@/lib/program-ids";

const WRAPPER = resolveDevnetProgramIds().wrapper;
const timeout = () => new Error("Confirmation timeout (60s) — tx may still land. Signature: 5abc");
const refusal = (code: number) =>
  Object.assign(new Error(`Transaction simulation failed: {"InstructionError":[3,{"Custom":${code}}]}`), {
    name: "SimulationRefusal", code, programId: WRAPPER, logs: [] as string[],
  });

describe("one-shot copy never claims a broadcast tx was not sent", () => {
  it("confirmation timeout under oneShot keeps 'Still confirming' and never says 'Nothing was sent'", () => {
    const u = resolveUserMessage(timeout(), { surface: "trade", oneShot: true });
    expect(u.kind).toBe("still-confirming");
    expect(u.body).not.toMatch(/nothing was sent/i);
    expect(u.body).toMatch(/still confirming/i);
  });

  it("CONTROL: a pre-send catching-up refusal under oneShot still gets the one-shot line", () => {
    const u = resolveUserMessage(refusal(WRAPPER_ERR.EngineLockActive), { surface: "trade", oneShot: true });
    expect(u.body).toMatch(/nothing was sent/i);
    expect(u.autoRetry ?? false).toBe(false);
  });
});
