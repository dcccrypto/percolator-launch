import { describe, it, expect } from "vitest";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { WRAPPER_ERR } from "@/lib/wrapper-errors";

const W = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const err = (code: number) => new Error(`Transaction simulation failed: Error processing Instruction 4: custom program error: 0x${code.toString(16)}
Program ${W} failed: custom program error: 0x${code.toString(16)}`);

describe("Earn deposit refused with EngineCounterUnderflow (25) — calm message (2026-10-02, OTC)", () => {
  it("earn-deposit: 'Vault is settling' instead of 'Something went wrong'", () => {
    const m = resolveUserMessage(err(WRAPPER_ERR.EngineCounterUnderflow) as never, { surface: "earn-deposit" } as never);
    expect(m.title).toBe("Vault is settling");
    expect(m.body).toMatch(/Nothing was sent/);
  });
  it("CONTROL: earn-withdraw keeps its own message", () => {
    const m = resolveUserMessage(err(WRAPPER_ERR.EngineCounterUnderflow) as never, { surface: "earn-withdraw" } as never);
    expect(m.title).toBe("Can't pay out in full");
  });
});

describe("Earn deposit refused with LpVaultTargetPotImpaired (91) — wrapper 7a3ac04c NAV floor", () => {
  it("maps Custom(91) from the wrapper to calm Earn-deposit copy, not 'Something went wrong'", () => {
    expect(WRAPPER_ERR.LpVaultTargetPotImpaired).toBe(91);
    const m = resolveUserMessage(err(91) as never, { surface: "earn-deposit" } as never);
    expect(m.kind).toBe("earn-pot-impaired");
    expect(m.title).toBe("Deposits paused");
    expect(m.body).toMatch(/Earn deposits are paused while this vault settles/);
    expect(m.body).toMatch(/Nothing was sent/);
    expect(m.body).not.toMatch(/Custom|0x5b|impair/i);
  });
  it("CONTROL: 92 (not a wrapper code) stays unmapped", () => {
    const m = resolveUserMessage(err(92) as never, { surface: "earn-deposit" } as never);
    expect(m.kind).toBe("unmapped");
  });
});

describe("Earn deposit refused BEFORE sending (planEarnDeposit -> EarnDepositsPausedError)", () => {
  it("same calm line as the program's 91, never 'Something went wrong'", async () => {
    const { EarnDepositsPausedError } = await import("@/lib/limits/earn-split-pot");
    const m = resolveUserMessage(new EarnDepositsPausedError("price-collapsed") as never, { surface: "earn-deposit" } as never);
    expect(m.kind).toBe("earn-pot-impaired");
    expect(m.body).toBe("Earn deposits are paused while this vault settles. Nothing was sent.");
  });
});
