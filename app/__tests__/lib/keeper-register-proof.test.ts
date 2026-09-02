import { describe, it, expect } from "vitest";
import {
  buildKeeperRegisterProofMessage,
  canonicalizeKeeperRegisterParams,
  type KeeperRegisterProofParams,
} from "@/lib/keeper-register-proof";

/**
 * GH#2505 / GH#2468 — the stateless deployer proof signed only
 * `keeper-register:<slabAddress>:<unix-minute>`.
 *
 * That authorised the SLAB and nothing else, so one captured signature let a
 * caller register that slab against ANY pool (#2468), and the parameters the
 * route acts on were never covered by the thing verifying them (#2505).
 *
 * These tests are about the MESSAGE, which is where the defect lived. If two
 * different registrations can produce the same bytes, the signature over those
 * bytes cannot distinguish them — no amount of verification logic downstream
 * recovers that.
 */

const base: KeeperRegisterProofParams = {
  slabAddress: "7RXTVmGcJMDqqTCFu5ADQRyLDvVZBi3r5U5WXzoULHJV",
  dexPoolAddress: "PooLAAAA1111111111111111111111111111111111",
  mainnetCA: "So11111111111111111111111111111111111111112",
  dexType: "meteora-dlmm",
  symbol: "SOL",
  label: "SOL/USDC — Meteora DLMM",
};

const bytes = (p: KeeperRegisterProofParams, minute = 29_000_000) =>
  Buffer.from(buildKeeperRegisterProofMessage(p, minute)).toString("utf8");

describe("keeper-register proof binds the registration parameters (GH#2505, GH#2468)", () => {
  it("a substituted POOL produces a different message — the #2468 attack", () => {
    // The whole of #2468: same slab, same minute, different pool. Under the old
    // message these were byte-identical, so one signature authorised both.
    const attacker = { ...base, dexPoolAddress: "EviLPooL111111111111111111111111111111111" };
    expect(bytes(attacker)).not.toBe(bytes(base));
  });

  it("every bound field changes the message", () => {
    const variants: Array<[string, KeeperRegisterProofParams]> = [
      ["slabAddress", { ...base, slabAddress: "OtherSlab11111111111111111111111111111111" }],
      ["dexPoolAddress", { ...base, dexPoolAddress: "OtherPool11111111111111111111111111111111" }],
      ["mainnetCA", { ...base, mainnetCA: "OtherMint11111111111111111111111111111111" }],
      ["dexType", { ...base, dexType: "raydium-clmm" }],
      ["symbol", { ...base, symbol: "JUP" }],
      ["label", { ...base, label: "something else" }],
    ];
    for (const [field, v] of variants) {
      expect(bytes(v), `${field} must be covered by the signature`).not.toBe(bytes(base));
    }
  });

  it("the minute is still bound, so the tolerance window stays finite", () => {
    expect(bytes(base, 29_000_000)).not.toBe(bytes(base, 29_000_001));
  });

  it("is order-independent — client and route cannot disagree by object shape", () => {
    const reordered: KeeperRegisterProofParams = {
      label: base.label,
      symbol: base.symbol,
      dexType: base.dexType,
      mainnetCA: base.mainnetCA,
      dexPoolAddress: base.dexPoolAddress,
      slabAddress: base.slabAddress,
    };
    expect(bytes(reordered)).toBe(bytes(base));
  });

  it("an absent optional encodes as empty, not omitted", () => {
    // If optionals were dropped rather than emptied, {symbol: undefined} and
    // {symbol: ""} would differ while {symbol: undefined, label: "x"} could
    // collide with {symbol: "x", label: undefined} — two different registrations
    // sharing one signature.
    const noSymbol = { ...base, symbol: undefined };
    const emptySymbol = { ...base, symbol: "" };
    expect(bytes(noSymbol)).toBe(bytes(emptySymbol));

    const swapA: KeeperRegisterProofParams = { ...base, symbol: "X", label: undefined };
    const swapB: KeeperRegisterProofParams = { ...base, symbol: undefined, label: "X" };
    expect(bytes(swapA)).not.toBe(bytes(swapB));
  });

  it("a field's value cannot imitate the delimiter", () => {
    // The separator is ASCII Unit Separator (0x1F), which cannot be typed into
    // the wizard or appear in a base58 address. Even so, pin that a value
    // containing '=' — which CAN appear in a label — does not shift the parse.
    const tricky = { ...base, label: "symbol=JUP" };
    expect(bytes(tricky)).not.toBe(bytes({ ...base, symbol: "JUP" }));
  });

  it("canonicalisation is stable for identical input", () => {
    expect(canonicalizeKeeperRegisterParams(base)).toBe(canonicalizeKeeperRegisterParams({ ...base }));
  });

  it("still binds the slab — the property the old message had, kept", () => {
    // Guard against "fixing" this by replacing the slab binding rather than
    // adding to it.
    const msg = bytes(base);
    expect(msg).toContain(base.slabAddress);
    expect(msg).toContain("keeper-register");
  });
});
