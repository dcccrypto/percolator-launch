/** v2.2 QA P-3: the 98 / 92 / 49 lines render in the ticket's StatusLine (title + body, no raw code). */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { SimulationRefusal } from "@/lib/tx";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { StatusLine } from "@/components/ui/StatusLine";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";

const wrapper = new PublicKey(resolveDevnetProgramIds().wrapper);
const refusal = (code: number) =>
  new SimulationRefusal({ InstructionError: [0, { Custom: code }] }, [`Program ${wrapper.toBase58()} failed: custom program error: 0x${code.toString(16)}`], [
    new TransactionInstruction({ programId: wrapper, keys: [], data: Buffer.from([10]) }),
  ]);

describe("P-3: 98 / 92 / 49 render", () => {
  afterEach(() => { cleanup(); __setDevnetV22ForTest(null); __setDevnetV21ForTest(null); });
  it.each([
    [98, "Fee updated"],
    [92, "Leverage too high here"],
    [49, "Not enough margin"],
  ])("Custom(%i) renders '%s' with its one-line body", (code, title) => {
    __setDevnetV22ForTest(true);
    __setDevnetV21ForTest(true);
    const m = resolveUserMessage(refusal(code), { surface: "trade", side: "long", symbol: "CHILLHOUSE" });
    render(<StatusLine message={m} />);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(m.body)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Something went wrong|error \d+|Custom/);
  });
});
