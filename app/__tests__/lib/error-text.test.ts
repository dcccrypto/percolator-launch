// @vitest-environment node
import { describe, expect, it } from "vitest";
import { errorText } from "@/lib/error-text";
import { humanizeError } from "@/lib/errorMessages";

describe("errorText (QA E2E-4: never '[object Object]')", () => {
  it("Errors and strings are unchanged", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
  });
  it("a JSON-RPC error body / wallet rejection object keeps its message and code", () => {
    expect(errorText({ code: -32002, message: "Transaction simulation failed" })).toBe("Transaction simulation failed (code -32002)");
    expect(errorText({ code: 4001, message: "User rejected the request." })).toBe("User rejected the request. (code 4001)");
  });
  it("a simulation InstructionError object reads like web3.js, so the code maps", () => {
    const t = errorText({ InstructionError: [3, { Custom: 121 }] });
    expect(t).toBe("Error processing Instruction 3: custom program error: 0x79");
    expect(errorText({ err: { InstructionError: [2, "ProgramFailedToComplete"] } })).toBe("Error processing Instruction 2: ProgramFailedToComplete");
    expect(humanizeError(t, "trade")).not.toMatch(/object Object/);
  });
  it("NEGATIVE CONTROL: the old pattern gives '[object Object]' for the same value; anything else is JSON", () => {
    const e: unknown = { InstructionError: [3, { Custom: 121 }] };
    expect(e instanceof Error ? e.message : String(e)).toBe("[object Object]");
    expect(errorText({ foo: 1 })).toBe('{"foo":1}');
    expect(errorText(undefined)).toBe("undefined");
    const circ: Record<string, unknown> = {}; circ.self = circ;
    expect(errorText(circ)).toBe("[object Object]");
  });
});
