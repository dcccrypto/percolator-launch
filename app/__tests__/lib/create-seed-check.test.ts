import { describe, expect, it } from "vitest";
import { checkSeedBalance, decideSeed, type TopUp } from "@/lib/create-seed-check";

const need = 3_100_000_000n;
const short = checkSeedBalance({ balanceAtoms: 400_000_000n, readFailed: false, needAtoms: need });

describe("checkSeedBalance", () => {
  it("exactly enough and more than enough pass; zero is short, not unknown", () => {
    expect(checkSeedBalance({ balanceAtoms: need, readFailed: false, needAtoms: need }).kind).toBe("ok");
    expect(checkSeedBalance({ balanceAtoms: need + 1n, readFailed: false, needAtoms: need }).kind).toBe("ok");
    expect(checkSeedBalance({ balanceAtoms: 0n, readFailed: false, needAtoms: need }).kind).toBe("short");
  });
  it("not read yet is checking; a failed read is unknown, even with an old value", () => {
    expect(checkSeedBalance({ balanceAtoms: null, readFailed: false, needAtoms: need }).kind).toBe("checking");
    expect(checkSeedBalance({ balanceAtoms: null, readFailed: true, needAtoms: need }).kind).toBe("unknown");
    expect(checkSeedBalance({ balanceAtoms: need * 2n, readFailed: true, needAtoms: need }).kind).toBe("unknown");
  });
});

describe("decideSeed", () => {
  const d = (topUp: TopUp, check = short) => decideSeed(check, topUp, "USDC", 6);
  it("ok: not blocked, no notice", () => {
    expect(decideSeed({ kind: "ok" }, { kind: "checking" }, "USDC", 6)).toEqual({ blocked: false });
  });
  it("short + top-up available: not blocked, plain note", () => {
    const v = d({ kind: "available" });
    expect(v.blocked).toBe(false);
    expect(v.notice?.message).toBe("Your wallet has 400 USDC. The launch adds the missing 2,700 test USDC first.");
  });
  it("short + top-up unknown: not blocked, says it can't confirm", () => {
    const v = d({ kind: "unknown" });
    expect(v.blocked).toBe(false);
    expect(v.notice?.message).toMatch(/can't confirm/);
  });
  it("short + top-up still being checked: blocked for now", () => {
    expect(d({ kind: "checking" }).blocked).toBe(true);
  });
  it("short + top-up unavailable: blocked with the exact shortfall sentence; faucet link only when the faucet is open", () => {
    const open = d({ kind: "unavailable", nextClaimAt: null, faucetOpen: true });
    expect(open.blocked).toBe(true);
    expect(open.notice?.message).toBe("You need 3,100 USDC to seed this market; your wallet has 400.");
    expect(open.notice?.faucetHref).toBe("/faucet");
    expect(d({ kind: "unavailable", nextClaimAt: null, faucetOpen: false }).notice?.faucetHref).toBeUndefined();
  });
  it("balance checking / unknown: blocked whatever the top-up says; unknown offers Retry", () => {
    const a = decideSeed({ kind: "checking" }, { kind: "available" }, "USDC", 6);
    expect(a.blocked).toBe(true);
    const b = decideSeed({ kind: "unknown" }, { kind: "available" }, "USDC", 6);
    expect(b.blocked).toBe(true);
    expect(b.notice?.retry).toBe("balance");
  });
});
