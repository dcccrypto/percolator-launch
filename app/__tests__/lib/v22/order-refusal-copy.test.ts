// @vitest-environment node
/**
 * v2.2 QA P-3 (#2959 family): an oversized open is refused 9, 98, 92 or 49 depending on the binding limit. 98, 92 and
 * 49, as the trade ticket receives them (a pre-sign SimulationRefusal attributed to the wrapper), each resolve to a
 * clear one-line message, never "Something went wrong". (9 is lib/v22/trade-refusal-9.ts, QA Q-1 / Q-6.)
 */
import { afterEach, describe, expect, it } from "vitest";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { SimulationRefusal } from "@/lib/tx";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";

const wrapper = new PublicKey(resolveDevnetProgramIds().wrapper);
const refusal = (code: number): SimulationRefusal =>
  new SimulationRefusal({ InstructionError: [1, { Custom: code }] }, [`Program ${wrapper.toBase58()} failed: custom program error: 0x${code.toString(16)}`], [
    new TransactionInstruction({ programId: new PublicKey("ComputeBudget111111111111111111111111111111"), keys: [], data: Buffer.alloc(1) }),
    new TransactionInstruction({ programId: wrapper, keys: [], data: Buffer.from([10]) }),
  ]);
const ctx = { surface: "trade" as const, side: "short" as const, symbol: "SOL" };

describe("P-3: every oversized-open code has a clear one-line message", () => {
  afterEach(() => {
    __setDevnetV22ForTest(null);
    __setDevnetV21ForTest(null);
  });

  it.each([
    [98, "growth-busy-fee"],
    [92, "growth-leverage"],
    [49, "insufficient-margin"],
  ])("Custom(%i) -> %s", (code, kind) => {
    __setDevnetV22ForTest(true);
    __setDevnetV21ForTest(true);
    const m = resolveUserMessage(refusal(code), ctx);
    expect(m.kind).toBe(kind);
    expect(m.variant).not.toBe("info");
    expect(m.body).not.toMatch(/something went wrong/i);
    expect(m.body.split("\n")).toHaveLength(1);
  });

  it("49 with the market's minimum initial margin names the floor (GH#2959)", () => {
    __setDevnetV22ForTest(true);
    __setDevnetV21ForTest(true);
    const m = resolveUserMessage(refusal(49), { ...ctx, imFloorLabel: "$2" });
    expect(m.body).toBe("New positions on this market need at least $2 of margin.");
  });
});
