import { V22_COPY } from "@/lib/v22/copy";
/**
 * v2.2 error copy: wrapper 104..124 and stake 33..48 map to calm one-line messages ONLY with the flag on.
 * Special handling: 104 is not red, 117/124 re-quote, 118 retries by itself, 121 keeps the v2.1 line.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __setDevnetV21ForTest } from "@/lib/v21/flag";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { resolveUserMessage } from "@/lib/limits/user-message";
import { humanizeError } from "@/lib/errorMessages";
import { resolveDevnetProgramIds } from "@/lib/program-ids";
import { V22_COUNTERPARTY_CAP_COPY, V22_CUSTOM9_COPY, V22_CUSTOM9_GENERIC, V22_POSITION_CAP_COPY } from "@/lib/v22/trade-refusal-9-copy";
import { V22_DEPTH_INPUT_COPY, V22_DEPTH_SOURCE_COPY, V22_TIER_CONFIG_COPY } from "@/lib/v22/copy";
import { V22_ERROR_CODE_MAP, V22_STAKE_ERROR_CODE_MAP } from "@/lib/v22/error-copy";
import { WRAPPER_ERR_V22, STAKE_ERR_V5, STAKE_ERR_DEPOSIT_BELOW_MIN_LIQUIDITY } from "@/lib/v22/wrapper-errors";
import { STAKE_ERRORS_V5 } from "@/lib/v22/sdk";

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
  it("covers wrapper 104..119, 123..130", () => {
    expect([...wrapperCodes].sort((a, b) => a - b)).toEqual([104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 123, 124, 125, 126, 127, 128, 129, 130]);
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
  it("covers stake 33..48", () => expect(stakeCodes).toEqual([33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48]));
  it.each(stakeCodes)("stake %i is attributed to the stake program, not the wrapper", (code) => {
    const m = resolveUserMessage(fail(code, ids.stake), { surface: "stake" });
    expect(m.body).toBe(V22_STAKE_ERROR_CODE_MAP[code]);
    expect(m.body).not.toMatch(/\n/);
    // The same number from the wrapper keeps its own meaning (33..45 are wrapper codes too).
    expect(resolveUserMessage(fail(code, ids.wrapper), { surface: "stake" }).body).not.toBe(V22_STAKE_ERROR_CODE_MAP[code]);
  });
});

// percolator-stake fix/v22-stake-310-313-combined src/error.rs: 46 CreatorAccountRequired (RecoverTerminalInsurance close-out
// owes the creator part of the surplus and no creator token account was passed), 47 InsuranceCustodyNotBound (BurnAssetAdmin
// before asset 0's insurance authority AND operator are the pool's vault_auth), 48 MultiAssetMarketNotSupported (InitPool /
// BindInsuranceAuthority on a multi-asset market, or one whose permissionless market-init fee is not 0).
describe("stake errors 46..48 (security review 2026-10-14)", () => {
  const COPY: Record<number, [string, string]> = {
    46: ["CreatorAccountRequired", "This pool's creator is owed part of what's left, so their account must be included to finish the close-out. Nothing was changed."],
    47: ["InsuranceCustodyNotBound", "Hand this market's insurance to the stake pool first; the admin key can be burned after that. Nothing was changed."],
    48: ["MultiAssetMarketNotSupported", "Stake pools need a single-asset market (and, for a new pool, the fee for adding assets set to 0). Nothing was changed."],
  };
  it.each([46, 47, 48])("stake %i: stable name, its calm line, structured and plain resolvers agree", (code) => {
    const [name, body] = COPY[code];
    expect(STAKE_ERR_V5[name as keyof typeof STAKE_ERR_V5]).toBe(code);
    expect(STAKE_ERRORS_V5[code]).toEqual({ name, hint: body });
    expect(V22_STAKE_ERROR_CODE_MAP[code]).toBe(body);
    expect(body).not.toMatch(JARGON);
    const m = resolveUserMessage(fail(code, ids.stake), { surface: "stake" });
    expect(m).toMatchObject({ kind: `stake-${name}`, variant: "info", body });
    expect(humanizeError(raw(code, ids.stake))).toBe(body);
  });
  it("flag off: not attributed", () => {
    __setDevnetV22ForTest(false);
    for (const code of [46, 47, 48]) {
      expect(resolveUserMessage(fail(code, ids.stake), { surface: "stake" }).body).not.toBe(COPY[code][1]);
      expect(humanizeError(raw(code, ids.stake))).not.toBe(COPY[code][1]);
    }
  });
});

describe("stake error 28: first deposit into an empty pool / senior / junior sub-pool", () => {
  const COPY = "First deposit into this pool must be more than 1,000 units.";
  it("is code 28 and maps to one calm line", () => {
    expect(STAKE_ERR_DEPOSIT_BELOW_MIN_LIQUIDITY).toBe(28);
    expect(V22_STAKE_ERROR_CODE_MAP[28]).toBe(COPY);
    expect(V22_STAKE_ERROR_CODE_MAP[28]).not.toMatch(JARGON);
  });
  it("structured message from the stake program, not the generic fallback", () => {
    const m = resolveUserMessage(fail(28, ids.stake), { surface: "stake" });
    expect(m.body).toBe(COPY);
    expect(m.variant).toBe("info");
    expect(m.kind).toBe("stake-min-first-deposit");
    expect(m.title).toBe("Deposit a little more");
    expect(m.body).not.toMatch(/\n/);
  });
  it("humanizeError on a stake-attributed 28 uses the same line; a wrapper 28 does not", () => {
    expect(humanizeError(raw(28, ids.stake))).toBe(COPY);
    expect(resolveUserMessage(fail(28, ids.wrapper), { surface: "stake" }).body).not.toBe(COPY);
  });
  it("flag off: not attributed", () => {
    __setDevnetV22ForTest(false);
    expect(resolveUserMessage(fail(28, ids.stake), { surface: "stake" }).body).not.toBe(COPY);
  });
});

describe("legacy string resolver", () => {
  it.each(Object.values(STAKE_ERR_V5))("stake %i via humanizeError uses the stake table", (code) => {
    expect(humanizeError(raw(code, ids.stake))).toBe(V22_STAKE_ERROR_CODE_MAP[code]);
  });
});

describe("special handling", () => {
  it("104 is a calm wait, never red, with the SDK 3985c76 wording (QA P-4)", () => {
    const m = resolveUserMessage(fail(WRAPPER_ERR_V22.PriceBandPinned), { surface: "close" });
    expect(m.variant).toBe("wait");
    expect(m.variant).not.toBe("error");
    expect(m.body).toBe("The price is still catching up after a big move. Closing reopens when it has; this usually takes a few minutes.");
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

describe("126 / 127: named position-cap refusals (percolator-prog fix/v22-p1-position-cap-error)", () => {
  it("126 shows the same line as the ticket pre-check / classified 9, in both resolvers", () => {
    const m = resolveUserMessage(fail(126), { surface: "trade" });
    expect(m).toMatchObject({ kind: "position-cap", title: "Position limit reached", body: V22_CUSTOM9_COPY["position-cap"] });
    expect(m.body.startsWith(V22_POSITION_CAP_COPY.replace(/ Close one.*$/, ""))).toBe(true);
    expect(humanizeError(raw(126))).toBe(V22_CUSTOM9_COPY["position-cap"]);
  });
  it("127 names the counterparty, not the user", () => {
    const m = resolveUserMessage(fail(127), { surface: "trade" });
    expect(m.kind).toBe("counterparty-cap");
    expect(m.body).toBe(V22_COUNTERPARTY_CAP_COPY);
    expect(m.body).toMatch(/other side/);
    expect(m.body).not.toBe(resolveUserMessage(fail(126), { surface: "trade" }).body);
    expect(humanizeError(raw(127))).toBe(V22_COUNTERPARTY_CAP_COPY);
  });
  it("negative control: a bare 9 on a trade is unchanged (generic, no cap claim) and 131 is unknown", () => {
    expect(humanizeError(raw(9), "trade")).toBe(V22_CUSTOM9_GENERIC);
    expect(resolveUserMessage(fail(9), { surface: "trade" }).kind).not.toMatch(/cap/);
    expect(resolveUserMessage(fail(131), { surface: "trade" }).kind).not.toMatch(/cap/);
    expect(V22_ERROR_CODE_MAP[131]).toBeUndefined();
  });
  it("flag off: 126 / 127 are not interpreted", () => {
    __setDevnetV22ForTest(false);
    expect(resolveUserMessage(fail(126), { surface: "trade" }).kind).not.toMatch(/cap/);
    expect(humanizeError(raw(127))).not.toBe(V22_COUNTERPARTY_CAP_COPY);
  });
});

describe("128: DepthInputInvalid (a keeper price push; a trader should essentially never see it)", () => {
  it("is calm, one line, says nothing changed, and is named for the SDK table", () => {
    const m = resolveUserMessage(fail(128), { surface: "trade" });
    expect(m).toMatchObject({ kind: "depth-input", body: V22_DEPTH_INPUT_COPY });
    expect(V22_DEPTH_INPUT_COPY).toBe("The market's depth reading was not accepted, so nothing changed. Try again in a moment.");
    expect(humanizeError(raw(128))).toBe(V22_DEPTH_INPUT_COPY);
    expect(m.kind).not.toMatch(/cap/);
  });
  it("flag off: 128 is not interpreted", () => {
    __setDevnetV22ForTest(false);
    expect(humanizeError(raw(128))).not.toBe(V22_DEPTH_INPUT_COPY);
  });
});

describe("129 / 130: DepthSourceInvalid, GrowthTierConfigInvalid", () => {
  it("129 is a keeper-side refusal: calm, nothing changed", () => {
    const m = resolveUserMessage(fail(129), { surface: "trade" });
    expect(m).toMatchObject({ kind: "depth-source", body: V22_DEPTH_SOURCE_COPY });
    expect(V22_DEPTH_SOURCE_COPY).toBe("The market's pool reading was not accepted, so nothing changed. Try again in a moment.");
    expect(humanizeError(raw(129))).toBe(V22_DEPTH_SOURCE_COPY);
  });
  it("130 points at the wizard field", () => {
    const m = resolveUserMessage(fail(130), { surface: "any" });
    expect(m).toMatchObject({ kind: "tier-config", body: V22_TIER_CONFIG_COPY });
    expect(V22_TIER_CONFIG_COPY).toBe("These leverage tiers are outside the safe limits, so nothing was created. Open Advanced: leverage tiers and adjust the amounts or leverage.");
    expect(V22_TIER_CONFIG_COPY).toMatch(/Advanced: leverage tiers/);
    expect(humanizeError(raw(130))).toBe(V22_TIER_CONFIG_COPY);
  });
  it("flag off: not interpreted", () => {
    __setDevnetV22ForTest(false);
    expect(humanizeError(raw(130))).not.toBe(V22_TIER_CONFIG_COPY);
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
  it("104 says which close is refused (QA P-4), keeps 'up to about an hour' only in Details (why), and does not auto-retry", () => {
    const m = resolveUserMessage(fail(104), { surface: "close" });
    expect(m.body).toBe(V22_COPY.band.catchingUp);
    expect(m.why).toMatch(/up to about an hour/);
    expect(m.autoRetry).toBeFalsy();
  });
});

describe("round i: a 104 close never reads as the 'catching up' of a 21", () => {
  it("104 on a close: title says the close is on hold; 21 on a close keeps the market-catching-up line", () => {
    const m104 = resolveUserMessage(fail(WRAPPER_ERR_V22.PriceBandPinned), { surface: "close" });
    expect(m104.title).toBe("Close on hold");
    expect(m104.title.toLowerCase()).not.toContain("catching");
    const m21 = resolveUserMessage(fail(21), { surface: "close" });
    expect(m21.kind).toBe("engine-catching-up");
    expect(m21.body).toBe("The price is still catching up after a big move. Closing reopens when it has; this usually takes a few minutes.");
  });
});
