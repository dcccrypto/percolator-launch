import { describe, it, expect } from "vitest";
import {
  EXIT_MAX_COMPUTE_UNITS,
  EXIT_MAX_REQUOTES,
  EXIT_REFRESH_DELAYS_MS,
  classifyExitError,
  initialExitRetryState,
  nextExitStep,
} from "@/lib/v22/exit-retry";
import { parseFailure } from "@/lib/limits/user-message";

describe("v22 exit retry machine", () => {
  it("118 refreshes with the bounded delays, then waits for the sweep (never an error)", () => {
    let st = initialExitRetryState();
    const delays: number[] = [];
    for (;;) {
      const s = nextExitStep(st, { kind: "notLossCurrent" });
      if (s.action !== "refresh-and-retry") {
        expect(s.action).toBe("wait-for-sweep");
        break;
      }
      delays.push(s.delayMs);
      st = s.state;
    }
    expect(delays).toEqual([...EXIT_REFRESH_DELAYS_MS]);
  });

  it("117 requotes up to the bound, then asks the user", () => {
    let st = initialExitRetryState();
    let n = 0;
    for (;;) {
      const s = nextExitStep(st, { kind: "belowMinPayout" });
      if (s.action === "requote") {
        n++;
        st = s.state;
        continue;
      }
      expect(s.action).toBe("ask-user");
      break;
    }
    expect(n).toBe(EXIT_MAX_REQUOTES);
  });

  it("a compute overrun is NEVER 118: it raises units once, then fails", () => {
    const a = nextExitStep(initialExitRetryState(), { kind: "computeBudgetExceeded" });
    expect(a.action).toBe("raise-units");
    if (a.action !== "raise-units") return;
    expect(nextExitStep(a.state, { kind: "computeBudgetExceeded" }).action).toBe("fail");
    expect(EXIT_MAX_COMPUTE_UNITS).toBe(1_400_000);
  });

  it("other errors pass through at once; ok proceeds", () => {
    expect(nextExitStep(initialExitRetryState(), { kind: "other", error: new Error("x") }).action).toBe("fail");
    expect(nextExitStep(initialExitRetryState(), { kind: "ok" }).action).toBe("proceed");
  });

  it("classifies thrown errors by code, and a CU overrun text wins over any code", () => {
    expect(classifyExitError(new Error("custom program error: 0x76"), parseFailure).kind).toBe("notLossCurrent");
    expect(classifyExitError(new Error("custom program error: 0x75"), parseFailure).kind).toBe("belowMinPayout");
    expect(classifyExitError(new Error("Program failed: exceeded CUs meter at BPF instruction"), parseFailure).kind).toBe("computeBudgetExceeded");
    expect(classifyExitError(new Error("custom program error: 0x1"), parseFailure).kind).toBe("other");
  });
});
