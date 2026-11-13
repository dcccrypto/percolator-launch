import { describe, expect, it } from "vitest";
import { checkSeedBalance, seedCheckMessage } from "@/lib/create-seed-check";

describe("checkSeedBalance / seedCheckMessage", () => {
  const need = 3_100_000_000n;
  it("short: the exact sentence the owner asked for", () => {
    const c = checkSeedBalance({ balanceAtoms: 400_000_000n, readFailed: false, needAtoms: need });
    expect(seedCheckMessage(c, "USDC", 6)).toBe("You need 3,100 USDC to seed this market; your wallet has 400.");
  });
  it("exactly enough and more than enough pass", () => {
    expect(checkSeedBalance({ balanceAtoms: need, readFailed: false, needAtoms: need }).kind).toBe("ok");
    expect(checkSeedBalance({ balanceAtoms: need + 1n, readFailed: false, needAtoms: need }).kind).toBe("ok");
  });
  it("a zero balance is short, not unknown", () => {
    expect(checkSeedBalance({ balanceAtoms: 0n, readFailed: false, needAtoms: need }).kind).toBe("short");
  });
  it("not read yet is checking; a failed read is unknown, even with an old value", () => {
    expect(checkSeedBalance({ balanceAtoms: null, readFailed: false, needAtoms: need }).kind).toBe("checking");
    expect(checkSeedBalance({ balanceAtoms: null, readFailed: true, needAtoms: need }).kind).toBe("unknown");
    expect(checkSeedBalance({ balanceAtoms: need * 2n, readFailed: true, needAtoms: need }).kind).toBe("unknown");
  });
  it("ok has no message", () => {
    expect(seedCheckMessage({ kind: "ok" }, "USDC", 6)).toBeNull();
  });
});
