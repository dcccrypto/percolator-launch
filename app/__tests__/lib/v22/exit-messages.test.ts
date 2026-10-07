// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const refusal = (code: number) => ({
  name: "SimulationRefusal",
  message: `custom program error: 0x${code.toString(16)}`,
  code,
  programId: resolveDevnetProgramIds().wrapper,
  logs: [],
});

afterEach(() => __setDevnetV22ForTest(null));

describe("v22 exit error mapping (flag on)", () => {
  it("118 -> calm refreshing line, auto-retry, never red", () => {
    __setDevnetV22ForTest(true);
    const m = resolveUserMessage(refusal(118), { surface: "earn-withdraw" });
    expect(m.kind).toBe("exit-refreshing");
    expect(m.variant).toBe("wait");
    expect(m.autoRetry).toBe(true);
    expect(m.body).toBe("Refreshing positions…");
  });
  it("117 -> re-quote", () => {
    __setDevnetV22ForTest(true);
    const m = resolveUserMessage(refusal(117), { surface: "earn-withdraw" });
    expect(m.requote).toBe(true);
    expect(m.variant).not.toBe("error");
  });
  it("104 -> 'Price is catching up; closing reopens shortly.', not red", () => {
    __setDevnetV22ForTest(true);
    const m = resolveUserMessage(refusal(104), { surface: "close" });
    expect(m.body).toBe("Price is catching up; closing reopens shortly.");
    expect(m.variant).toBe("wait");
  });
  it("flag OFF: 117/118 are not interpreted by the v2.2 table", () => {
    __setDevnetV22ForTest(false);
    expect(resolveUserMessage(refusal(118), { surface: "earn-withdraw" }).kind).not.toBe("exit-refreshing");
    expect(resolveUserMessage(refusal(117), { surface: "earn-withdraw" }).requote).toBeUndefined();
  });
});
