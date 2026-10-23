// @vitest-environment node
/** v2.2 QA Q-4: wrapper 38 LpVaultNoFeesToCrank on an Earn action is a calm retry line, not "Something went wrong". */
import { describe, expect, it } from "vitest";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { resolveDevnetProgramIds } from "@/lib/program-ids";

const w = resolveDevnetProgramIds().wrapper;
const e38 = () => new Error(`Simulation failed: Program ${w} failed: custom program error: 0x26`);

describe("Q-4: Earn error 38", () => {
  it.each(["earn-withdraw", "earn-deposit"] as const)("%s -> retry line", (surface) => {
    const m = resolveUserMessage(e38(), { surface });
    expect(m.kind).toBe("earn-fees-collected");
    expect(m.body).toBe("Fees were just collected for this vault. Nothing moved. Try again.");
    expect(m.action?.id).toBe("try-again");
  });
  it("a stake-program 38 is not this line", () => {
    const m = resolveUserMessage(new Error(`Program ${resolveDevnetProgramIds().stake} failed: custom program error: 0x26`), { surface: "earn-withdraw" });
    expect(m.kind).not.toBe("earn-fees-collected");
  });
});
