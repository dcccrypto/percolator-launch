/**
 * Around the matcher-sync wrapper cutover an Earn tx can be built for the other program version
 * (a tab that cached "pre" sends the 91 repair the new wrapper refuses with Custom 91; after a
 * rollback a cached "post" omits the repair the old wrapper needs, Custom 25). A PRE-SIGN refusal
 * with either code drops the detection cache and rebuilds once; nothing is sent twice.
 */
import { describe, expect, it, vi } from "vitest";
import { sendWithUpgradeRetry } from "@/lib/limits/earn-ixs";
import { isEarnVersionRefusal } from "@/hooks/useInsuranceLP";
import { SimulationRefusal } from "@/lib/tx";
import { resolveUserMessage, EARN_WITHDRAW_RETRY_BODY, EARN_DEPOSITS_PAUSED_BODY } from "@/lib/limits/user-message";
import * as detect from "@/lib/program-upgrade-detect";

const W = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const refusal = (code: number, programId: string | null = W) => {
  const r = new SimulationRefusal({ InstructionError: [0, { Custom: code }] }, [`Program ${W} failed: custom program error: 0x${code.toString(16)}`]);
  Object.defineProperty(r, "code", { value: code });
  Object.defineProperty(r, "programId", { value: programId });
  return r;
};

describe("isEarnVersionRefusal", () => {
  it("wrapper 91 / 25 pre-sign refusals qualify; other codes, other programs, sent-tx errors do not", () => {
    expect(isEarnVersionRefusal(refusal(91))).toBe(true);
    expect(isEarnVersionRefusal(refusal(25))).toBe(true);
    expect(isEarnVersionRefusal(refusal(21))).toBe(false);
    expect(isEarnVersionRefusal(refusal(91, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"))).toBe(false);
    expect(isEarnVersionRefusal(new Error("custom program error: 0x5b"))).toBe(false); // not pre-sign
  });
});

describe("sendWithUpgradeRetry", () => {
  it("on a version refusal: invalidates detection and rebuilds ONCE", async () => {
    const spy = vi.spyOn(detect, "invalidateUpgradeDetection");
    let n = 0;
    const attempt = vi.fn(async () => {
      n++;
      if (n === 1) throw refusal(91);
      return "sig";
    });
    await expect(sendWithUpgradeRetry(attempt, isEarnVersionRefusal)).resolves.toBe("sig");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it("a second refusal is surfaced (no loop); other errors are not retried", async () => {
    const twice = vi.fn(async () => { throw refusal(25); });
    await expect(sendWithUpgradeRetry(twice, isEarnVersionRefusal)).rejects.toBeInstanceOf(SimulationRefusal);
    expect(twice).toHaveBeenCalledTimes(2);
    const other = vi.fn(async () => { throw refusal(21); });
    await expect(sendWithUpgradeRetry(other, isEarnVersionRefusal)).rejects.toBeInstanceOf(SimulationRefusal);
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe("Custom 91 copy depends on the surface", () => {
  const err = new Error(`Transaction simulation failed: custom program error: 0x5b\nProgram ${W} failed: custom program error: 0x5b`);
  it("withdraw screen: retry copy, never deposit copy", () => {
    const m = resolveUserMessage(err as never, { surface: "earn-withdraw" } as never);
    expect(m.body).toBe(EARN_WITHDRAW_RETRY_BODY);
    expect(m.body).not.toMatch(/deposit/i);
  });
  it("deposit screen: deposits paused", () => {
    expect(resolveUserMessage(err as never, { surface: "earn-deposit" } as never).body).toBe(EARN_DEPOSITS_PAUSED_BODY);
  });
});
