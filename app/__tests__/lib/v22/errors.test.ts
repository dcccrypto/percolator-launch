/**
 * v2.2 error copy: wrapper 104..124 and stake 33..45 map to calm one-line messages ONLY with the flag on.
 * Special handling: 104 is not red, 117/124 re-quote, 118 retries by itself, 121 keeps the v2.1 line.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { humanizeError } from "@/lib/errorMessages";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { V22_ERROR_CODE_MAP, V22_STAKE_ERROR_CODE_MAP } from "@/lib/v22/error-copy";
import { WRAPPER_ERR_V22, STAKE_ERR_V5 } from "@/lib/v22/wrapper-errors";

const ids = resolveDevnetProgramIds();
const fail = (code: number, programId: string | null = ids.wrapper): Error & { programId: string | null } => {
  const e = new Error(`Transaction simulation failed: {"InstructionError":[2,{"Custom":${code}}]}`) as Error & { programId: string | null };
  e.programId = programId;
  return e;
};
/** The raw text a wallet / RPC gives, with the failing program attributed (the legacy string resolver needs it). */
const raw = (code: number, programId: string = ids.wrapper): string =>
  `Transaction simulation failed: Error processing Instruction 2: custom program error: 0x${code.toString(16)}\nProgram ${programId} failed: custom program error: 0x${code.toString(16)}`;
const JARGON = /\b(tag \d+|Custom\(|lot_exp|band_bps|h-lock|kink|ADL|Q\d|u128|PDA)\b/i;

beforeEach(() => {
  __setDevnetV21ForTest(true);
  __setDevnetV22ForTest(true);
});
afterEach(() => {
  __setDevnetV21ForTest(null);
  __setDevnetV22ForTest(null);
});

describe("every new code has a calm one-line message", () => {
  const wrapperCodes = Object.values(WRAPPER_ERR_V22);
  it("covers wrapper 104..119, 123, 124", () => {
    expect([...wrapperCodes].sort((a, b) => a - b)).toEqual([104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 123, 124]);
  });
  it.each(wrapperCodes)("wrapper %i: structured message and plain string, one line, no jargon", (code) => {
    const m = resolveUserMessage(fail(code), { surface: "any", minPositionLabel: "100 USDC" });
    expect(m.body.length).toBeGreaterThan(8);
    expect(m.body).not.toMatch(/\n/);
    expect(`${m.title} ${m.body}`).not.toMatch(JARGON);
    expect(V22_ERROR_CODE_MAP[code]).toBeTruthy();
    expect(V22_ERROR_CODE_MAP[code]).not.toMatch(JARGON);
    expect(humanizeError(raw(code))).toBe(V22_ERROR_CODE_MAP[code]);
  });
  const stakeCodes = Object.values(STAKE_ERR_V5);
  it("covers stake 33..45", () => expect(stakeCodes).toEqual([33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45]));
  it.each(stakeCodes)("stake %i is attributed to the stake program, not the wrapper", (code) => {
    const m = resolveUserMessage(fail(code, ids.stake), { surface: "stake" });
    expect(m.body).toBe(V22_STAKE_ERROR_CODE_MAP[code]);
    expect(m.body).not.toMatch(/\n/);
    // The same number from the wrapper keeps its own meaning (33..45 are wrapper codes too).
    expect(resolveUserMessage(fail(code, ids.wrapper), { surface: "stake" }).body).not.toBe(V22_STAKE_ERROR_CODE_MAP[code]);
  });
});

describe("legacy string resolver", () => {
  it.each(Object.values(STAKE_ERR_V5))("stake %i via humanizeError uses the stake table", (code) => {
    expect(humanizeError(raw(code, ids.stake))).toBe(V22_STAKE_ERROR_CODE_MAP[code]);
  });
});

describe("special handling", () => {
  it("104 is a calm wait, never red, with the founder's wording", () => {
    const m = resolveUserMessage(fail(WRAPPER_ERR_V22.PriceBandPinned), { surface: "close" });
    expect(m.variant).toBe("wait");
    expect(m.variant).not.toBe("error");
    expect(m.body).toBe("Price is catching up; closing reopens shortly.");
    expect(m.kind).toBe("band-catching-up");
  });
  it("117 re-quotes (and does not stop the user)", () => {
    const m = resolveUserMessage(fail(WRAPPER_ERR_V22.RedemptionBelowMinPayout), { surface: "earn-withdraw" });
    expect(m).toMatchObject({ requote: true, variant: "wait" });
  });
  it("118 retries by itself inside the same action, calm, never red", () => {
    const m = resolveUserMessage(fail(WRAPPER_ERR_V22.ExitRequiresLossCurrent), { surface: "earn-withdraw" });
    expect(m).toMatchObject({ autoRetry: true, variant: "wait", body: "Refreshing positions…" });
  });
  it("121 keeps the existing v2.1 Refreshing positions line", () => {
    const m = resolveUserMessage(fail(121), { surface: "trade" });
    expect(m.kind).toBe("loss-stale");
    expect(m.title).toBe("Refreshing positions");
    expect(m.autoRetry).toBe(true);
  });
  it("113 names the market minimum when the caller knows it", () => {
    expect(resolveUserMessage(fail(113), { surface: "trade", minPositionLabel: "100 USDC" }).body).toContain("100 USDC");
  });
  it("124 re-quotes the bond price", () => {
    expect(resolveUserMessage(fail(124), { surface: "any" }).requote).toBe(true);
  });
});

describe("flag off: none of this is used (parity)", () => {
  it("104 / 117 / 118 get the generic resolver output, not the v2.2 copy", () => {
    __setDevnetV22ForTest(false);
    for (const code of [104, 117, 118]) {
      const m = resolveUserMessage(fail(code), { surface: "any" });
      expect(m.kind).not.toMatch(/^(band-|exit-|bond-)/);
      expect(m.body).not.toBe(V22_ERROR_CODE_MAP[code]);
    }
    expect(humanizeError(raw(104))).not.toBe(V22_ERROR_CODE_MAP[104]);
  });
  it("stake codes are not attributed to the stake program with the flag off", () => {
    __setDevnetV22ForTest(false);
    expect(resolveUserMessage(fail(33, ids.stake), { surface: "stake" }).body).not.toBe(V22_STAKE_ERROR_CODE_MAP[33]);
  });
});

describe("F10 honest copy", () => {
  beforeEach(() => {
    __setDevnetV21ForTest(true);
    __setDevnetV22ForTest(true);
  });
  afterEach(() => {
    __setDevnetV21ForTest(null);
    __setDevnetV22ForTest(null);
  });
  it("114 makes no retry promise; 116 and 110 claim nothing untrue", () => {
    expect(resolveUserMessage(fail(114), { surface: "any" }).body).not.toMatch(/try again|refreshed/i);
    expect(V22_ERROR_CODE_MAP[114]).not.toMatch(/try again|refreshed/i);
    expect(resolveUserMessage(fail(116), { surface: "any" }).body).not.toMatch(/isn't available/i);
    expect(resolveUserMessage(fail(110), { surface: "any" }).body).not.toMatch(/settings aren't valid/i);
  });
  it("104 keeps the founder's line, adds the honest 'up to about an hour' only in Details (why), and does not auto-retry", () => {
    const m = resolveUserMessage(fail(104), { surface: "close" });
    expect(m.body).toBe("Price is catching up; closing reopens shortly.");
    expect(m.why).toMatch(/up to about an hour/);
    expect(m.autoRetry).toBeFalsy();
  });
});
