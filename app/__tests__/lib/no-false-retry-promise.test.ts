/**
 * The resolver promised "we'll retry automatically" (and, for an Earn deposit, "Your trade goes
 * through automatically") on surfaces that never resend: nothing reads `autoRetry`, and only the
 * trade ticket waits through a refusal (sendTxWaiting). Those lines now say to try again; the
 * trade surface keeps its promise, because there it is true.
 */
import { describe, expect, it } from "vitest";
import { resolveUserMessage, type MessageSurface } from "@/lib/limits/user-message";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";
import { resolveDevnetProgramIds } from "@/lib/program-ids";

const WRAPPER = resolveDevnetProgramIds().wrapper;
const refusal = (code: number) =>
  Object.assign(new Error(`Transaction simulation failed: {"InstructionError":[2,{"Custom":${code}}]}`), {
    name: "SimulationRefusal", code, programId: WRAPPER, logs: [] as string[],
  });
const W = WRAPPER_ERR;
const CODES = [W.EngineStale, W.EngineBStale, W.EngineLockActive, W.VaultLpHarvestPending, W.VaultLpValuationStale, W.VaultLpSeniorDrawRequired];
const PROMISE = /retry automatically|goes through automatically/i;

describe("no automatic-retry promise where nothing retries", () => {
  for (const surface of ["earn-deposit", "earn-withdraw", "creator-stake", "close-market"] as MessageSurface[]) {
    for (const p3Bound of [false, true]) {
      it(`${surface}${p3Bound ? " (bound vault)" : ""}: no refusal promises a retry`, () => {
        for (const code of CODES) {
          const u = resolveUserMessage(refusal(code), { surface, p3Bound });
          expect(`${u.title} ${u.body}`, `code ${code}`).not.toMatch(PROMISE);
          expect(u.autoRetry ?? false, `code ${code}`).toBe(false);
        }
      });
    }
  }

  it("an Earn deposit refused EngineStale does not talk about a trade", () => {
    const u = resolveUserMessage(refusal(W.EngineStale), { surface: "earn-deposit" });
    expect(u.body).not.toMatch(/trade/i);
    expect(u.body).toBe("The price is still catching up after a big move. This usually takes a few minutes; try again then.");
  });

  it("the trade ticket keeps its promise (it waits through the refusal and resends)", () => {
    const u = resolveUserMessage(refusal(W.EngineStale), { surface: "trade", side: "long", symbol: "SOL" });
    expect(u.body).toMatch(/goes through automatically/);
    expect(u.autoRetry).toBe(true);
  });
});
