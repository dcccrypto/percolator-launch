// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseMarketCreationError, extractCustomCode } from "@/lib/parseMarketError";

const W = "ETDLAdiAyWnEUngspYczTXUceT6X8f92eZQvr8nmSkWB";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";

const tokenInner = (code: string) =>
  [
    `Program ${W} invoke [1]`,
    `Program ${TOKEN} invoke [2]`,
    `Program ${TOKEN} failed: custom program error: ${code}`,
    `Program ${W} failed: custom program error: ${code}`,
  ].join("\n");

describe("custom codes from a non-Percolator program are not read through the wrapper tables", () => {
  it("token OwnerMismatch (0x4) is not shown as the wrapper's InvalidAccountKind", () => {
    const out = parseMarketCreationError(new Error(tokenInner("0x4")));
    expect(out).not.toMatch(/Wrong account kind/);
  });

  it("token MintMismatch (0x3) is not shown as the wrapper's NotInitialized", () => {
    const out = parseMarketCreationError(new Error(tokenInner("0x3")), { step: "funding" });
    expect(out).not.toMatch(/not initialized/i);
  });

  it("system program 0x0 is not shown as the wrapper's InvalidMagic", () => {
    const msg = `Program ${SYSTEM} invoke [1]\nProgram ${SYSTEM} failed: custom program error: 0x0`;
    expect(parseMarketCreationError(new Error(msg))).not.toMatch(/Invalid magic/);
  });

  it("token 0x8 inner does not trigger the vault-lp wrapper Unauthorized override", () => {
    const out = parseMarketCreationError(new Error(tokenInner("0x8")), { step: "vault-lp" });
    expect(out).not.toMatch(/admin can connect the Earn vault/);
  });

  it("extractCustomCode returns null for a token-program code", () => {
    expect(extractCustomCode(tokenInner("0x4"))).toBeNull();
  });

  it("still maps a wrapper code, also after a successful token CPI", () => {
    const msg = [
      `Program ${W} invoke [1]`,
      `Program ${TOKEN} invoke [2]`,
      `Program ${TOKEN} success`,
      `Program ${W} failed: custom program error: 0x4`,
    ].join("\n");
    expect(extractCustomCode(msg)).toBe(4);
    expect(parseMarketCreationError(new Error(msg))).toMatch(/Wrong account kind/);
  });

  it("token 0x1 still routes to the insufficient token balance copy", () => {
    expect(parseMarketCreationError(new Error(tokenInner("0x1")))).toMatch(/Insufficient token balance/);
  });
});

describe("extractCustomCode JSON form", () => {
  it("does not take a stray 'Custom 8' after a non-Custom InstructionError", () => {
    expect(extractCustomCode(`{"InstructionError":[1,"InvalidAccountData"]} ... Custom 8 detail`)).toBeNull();
  });
  it("reads {Custom:N} and Custom(N)", () => {
    expect(extractCustomCode(`{"InstructionError":[3,{"Custom":19}]}`)).toBe(19);
    expect(extractCustomCode(`InstructionError(2, Custom(19))`)).toBe(19);
  });
});
