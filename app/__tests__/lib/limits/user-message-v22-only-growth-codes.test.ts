/** QA FUND-6 / E-121 follow-up: with ONLY the v2.2 flag set, the v2.1 growth / lock codes (also v2.2 codes) get their copy, not raw text. */
import { afterEach, describe, expect, it } from "vitest";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { SimulationRefusal } from "@/lib/tx";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";

const wrapper = new PublicKey(resolveDevnetProgramIds().wrapper);
const refusal = (code: number) =>
  new SimulationRefusal({ InstructionError: [0, { Custom: code }] }, [`Program ${wrapper.toBase58()} failed: custom program error: 0x${code.toString(16)}`], [
    new TransactionInstruction({ programId: wrapper, keys: [], data: Buffer.from([10]) }),
  ]);
const msg = (code: number) => resolveUserMessage(refusal(code), { surface: "trade", side: "long", symbol: "swordcat" });

describe("v2.2-only build: growth / lock codes resolve like v2.1", () => {
  afterEach(() => { __setDevnetV22ForTest(null); __setDevnetV21ForTest(null); });
  it.each([92, 121])("Custom(%i) with only v2.2 on matches the v2.1+v2.2 copy", (code) => {
    __setDevnetV21ForTest(true); __setDevnetV22ForTest(true);
    const both = msg(code);
    __setDevnetV21ForTest(false); __setDevnetV22ForTest(true);
    const only22 = msg(code);
    expect(only22.title).toBe(both.title);
    expect(only22.body).toBe(both.body);
    expect(`${only22.title} ${only22.body}`).not.toMatch(/Something went wrong|error \d+|Custom|0x/);
  });
});
