/**
 * Unit tests for lib/prefund-requirement.ts — the devnet pre-fund maths and the
 * refusal classifier shared by /api/devnet-pre-fund, CreateMarketWizard,
 * useCreateMarket and prefund-claim-store.
 *
 * The route tests exercise these through HTTP; this file pins the pure functions
 * directly: u64 edges, the backing-seed floor, the default floor in
 * fundingRequirement, where requirements land relative to MAX_FUNDABLE_REQUIREMENT
 * (the refusal itself is enforced and tested in the route), malformed inputs,
 * and every classifyPreFundRefusal outcome.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_INSURANCE_AMOUNT,
  DEFAULT_LP_COLLATERAL,
  MAX_FUNDABLE_REQUIREMENT,
  PREFUND_GATE_ERROR,
  PREFUND_WINDOW_MS,
  U64_MAX,
  classifyPreFundRefusal,
  fullMarketRequirement,
  fundAmountFor,
  fundingRequirement,
  parseAtomicAmount,
} from "@/lib/prefund-requirement";
import { BACKING_SEED_MIN_ATOMS, backingSeedPerDomain } from "@/lib/market-params";

// Default launch: LP 1,000 + insurance 100 + 2 × backing (100% of LP) = 3,100 tokens.
const DEFAULT_REQUIREMENT = 3_100_000_000n;

describe("constants", () => {
  it("pins the values the route and wizard depend on", () => {
    expect(DEFAULT_LP_COLLATERAL).toBe(1_000_000_000n);
    expect(DEFAULT_INSURANCE_AMOUNT).toBe(100_000_000n);
    expect(MAX_FUNDABLE_REQUIREMENT).toBe(10_000_000_000n);
    expect(U64_MAX).toBe(18_446_744_073_709_551_615n);
    expect(PREFUND_GATE_ERROR).toBe("Already pre-funded recently");
    expect(PREFUND_WINDOW_MS).toBe(3_600_000);
  });
});

describe("fullMarketRequirement", () => {
  it("is LP + insurance + two backing deposits for the default launch", () => {
    expect(fullMarketRequirement(DEFAULT_LP_COLLATERAL, DEFAULT_INSURANCE_AMOUNT)).toBe(
      DEFAULT_REQUIREMENT,
    );
  });

  it("matches backingSeedPerDomain rather than a restated percentage", () => {
    const lp = 123_456_789n;
    const ins = 7n;
    expect(fullMarketRequirement(lp, ins)).toBe(lp + ins + 2n * backingSeedPerDomain(lp));
  });

  it("applies the backing floor on BOTH domains when LP is zero", () => {
    expect(fullMarketRequirement(0n, 0n)).toBe(2n * BACKING_SEED_MIN_ATOMS);
    expect(fullMarketRequirement(0n, 5n)).toBe(5n + 2n * BACKING_SEED_MIN_ATOMS);
  });

  it("switches from the floor to the percentage exactly at the floor", () => {
    const below = BACKING_SEED_MIN_ATOMS - 1n;
    expect(fullMarketRequirement(below, 0n)).toBe(below + 2n * BACKING_SEED_MIN_ATOMS);
    expect(fullMarketRequirement(BACKING_SEED_MIN_ATOMS, 0n)).toBe(3n * BACKING_SEED_MIN_ATOMS);
    const above = BACKING_SEED_MIN_ATOMS + 1n;
    expect(fullMarketRequirement(above, 0n)).toBe(3n * above);
  });

  it("does not wrap at u64 — bigint keeps the full value so the ceiling can refuse it", () => {
    const r = fullMarketRequirement(U64_MAX, U64_MAX);
    expect(r).toBe(4n * U64_MAX);
    expect(r > U64_MAX).toBe(true);
    expect(r > MAX_FUNDABLE_REQUIREMENT).toBe(true);
  });
});

describe("fundingRequirement", () => {
  it("never drops below the default launch (no downward grief)", () => {
    expect(fundingRequirement(0n, 0n)).toBe(DEFAULT_REQUIREMENT);
    expect(fundingRequirement(1n, 1n)).toBe(DEFAULT_REQUIREMENT);
    expect(fundingRequirement(DEFAULT_LP_COLLATERAL - 1n, DEFAULT_INSURANCE_AMOUNT)).toBe(
      DEFAULT_REQUIREMENT,
    );
  });

  it("returns the floor when asked equals the floor", () => {
    expect(fundingRequirement(DEFAULT_LP_COLLATERAL, DEFAULT_INSURANCE_AMOUNT)).toBe(
      DEFAULT_REQUIREMENT,
    );
  });

  it("honours a larger ask", () => {
    expect(fundingRequirement(DEFAULT_LP_COLLATERAL, DEFAULT_INSURANCE_AMOUNT + 1n)).toBe(
      DEFAULT_REQUIREMENT + 1n,
    );
    expect(fundingRequirement(2_000_000_000n, 0n)).toBe(6_000_000_000n);
  });

  it("a small LP with large insurance can still beat the floor", () => {
    expect(fundingRequirement(0n, 4_000_000_000n)).toBe(4_000_000_000n + 2n * BACKING_SEED_MIN_ATOMS);
  });

  describe("against MAX_FUNDABLE_REQUIREMENT", () => {
    it("the default launch is fundable", () => {
      expect(fundingRequirement(DEFAULT_LP_COLLATERAL, DEFAULT_INSURANCE_AMOUNT) <= MAX_FUNDABLE_REQUIREMENT).toBe(true);
    });

    it("an LP seed of 3,300 tokens with default insurance lands exactly on the ceiling", () => {
      expect(fundingRequirement(3_300_000_000n, DEFAULT_INSURANCE_AMOUNT)).toBe(MAX_FUNDABLE_REQUIREMENT);
    });

    it("lands exactly on the ceiling and one atom over it", () => {
      // 3 × LP + insurance = 10,000 tokens.
      const lp = 3_000_000_000n;
      const ins = 1_000_000_000n;
      expect(fundingRequirement(lp, ins)).toBe(MAX_FUNDABLE_REQUIREMENT);
      expect(fundingRequirement(lp, ins + 1n)).toBe(MAX_FUNDABLE_REQUIREMENT + 1n);
      expect(fundingRequirement(lp, ins + 1n) > MAX_FUNDABLE_REQUIREMENT).toBe(true);
    });

    it("u64-max inputs come back unclamped and over the ceiling the route refuses against", () => {
      expect(fundingRequirement(U64_MAX, 0n)).toBe(3n * U64_MAX);
      expect(fundingRequirement(U64_MAX, 0n) > MAX_FUNDABLE_REQUIREMENT).toBe(true);
    });
  });
});

describe("fundAmountFor", () => {
  it("mints twice the requirement", () => {
    expect(fundAmountFor(DEFAULT_REQUIREMENT)).toBe(6_200_000_000n);
    expect(fundAmountFor(MAX_FUNDABLE_REQUIREMENT)).toBe(20_000_000_000n);
    expect(fundAmountFor(0n)).toBe(0n);
  });

  it("the max mint stays inside u64", () => {
    expect(fundAmountFor(MAX_FUNDABLE_REQUIREMENT) <= U64_MAX).toBe(true);
  });
});

describe("parseAtomicAmount", () => {
  const FALLBACK = 42n;

  it("falls back only when the field is absent", () => {
    expect(parseAtomicAmount(undefined, FALLBACK)).toBe(FALLBACK);
  });

  it("accepts digit strings", () => {
    expect(parseAtomicAmount("0", FALLBACK)).toBe(0n);
    expect(parseAtomicAmount("1000000000", FALLBACK)).toBe(1_000_000_000n);
    expect(parseAtomicAmount("0007", FALLBACK)).toBe(7n);
  });

  it("accepts exactly U64_MAX and refuses U64_MAX + 1", () => {
    expect(parseAtomicAmount(U64_MAX.toString(), FALLBACK)).toBe(U64_MAX);
    expect(parseAtomicAmount((U64_MAX + 1n).toString(), FALLBACK)).toBeNull();
  });

  it("refuses the largest 20-digit value even though it passes the digit bound", () => {
    expect(parseAtomicAmount("99999999999999999999", FALLBACK)).toBeNull();
  });

  // Pinned on purpose: the bound counts characters, so a zero-padded small value
  // over 20 characters is refused even though it fits in u64.
  it("leading zeros do not defeat the 20-digit bound", () => {
    expect(parseAtomicAmount("00000000000000000001", FALLBACK)).toBe(1n);
    expect(parseAtomicAmount("000000000000000000001", FALLBACK)).toBeNull();
  });

  it("refuses more than 20 digits", () => {
    expect(parseAtomicAmount("1".repeat(21), FALLBACK)).toBeNull();
  });

  it.each([
    ["empty string", ""],
    ["negative", "-1"],
    ["negative zero", "-0"],
    ["explicit plus", "+1"],
    ["float", "1.5"],
    ["trailing dot", "1."],
    ["exponent", "1e9"],
    ["hex", "0x10"],
    ["leading space", " 1"],
    ["trailing space", "1 "],
    ["trailing newline", "1\n"],
    ["underscore separator", "1_000"],
    ["comma separator", "1,000"],
    ["letters", "abc"],
    ["full-width digit", "１"],
    ["arabic-indic digit", "١"],
  ])("refuses %s", (_label, raw) => {
    expect(parseAtomicAmount(raw, FALLBACK)).toBeNull();
  });

  it.each([
    ["null", null],
    ["number", 1000],
    ["negative number", -1],
    ["NaN", Number.NaN],
    ["bigint", 1000n],
    ["boolean", true],
    ["object", { value: "1" }],
    ["array", ["1"]],
  ])("refuses a non-string %s", (_label, raw) => {
    expect(parseAtomicAmount(raw, FALLBACK)).toBeNull();
  });
});

describe("classifyPreFundRefusal", () => {
  const lpCollateral = DEFAULT_LP_COLLATERAL;
  const insuranceAmount = DEFAULT_INSURANCE_AMOUNT;
  const covers = fullMarketRequirement(lpCollateral, insuranceAmount);
  const base = { lpCollateral, insuranceAmount };

  describe("proceed", () => {
    it("when the balance exactly covers this launch, whatever the refusal", () => {
      expect(
        classifyPreFundRefusal({
          ...base,
          status: 429,
          body: { error: PREFUND_GATE_ERROR, nextClaimAt: "2026-11-16T01:00:00.000Z" },
          balance: covers,
        }),
      ).toEqual({ kind: "proceed" });
    });

    it("when the balance exceeds this launch on a non-429 refusal", () => {
      expect(
        classifyPreFundRefusal({ ...base, status: 500, body: null, balance: covers + 1n }),
      ).toEqual({ kind: "proceed" });
    });

    it("judges against THIS launch, not the route's default floor", () => {
      // A small launch the route would refuse (floored at the default) is still fine.
      const small = fullMarketRequirement(0n, 0n);
      expect(small < fundingRequirement(0n, 0n)).toBe(true);
      expect(
        classifyPreFundRefusal({
          status: 429,
          body: { error: PREFUND_GATE_ERROR },
          balance: small,
          lpCollateral: 0n,
          insuranceAmount: 0n,
        }),
      ).toEqual({ kind: "proceed" });
    });
  });

  describe("blocked", () => {
    const short = covers - 1n;

    it("429 with the gate error and a nextClaimAt", () => {
      expect(
        classifyPreFundRefusal({
          ...base,
          status: 429,
          body: { error: PREFUND_GATE_ERROR, nextClaimAt: "2026-11-16T01:00:00.000Z" },
          balance: short,
        }),
      ).toEqual({ kind: "blocked", nextClaimAt: "2026-11-16T01:00:00.000Z" });
    });

    it("429 with the gate error and no nextClaimAt", () => {
      expect(
        classifyPreFundRefusal({ ...base, status: 429, body: { error: PREFUND_GATE_ERROR }, balance: short }),
      ).toEqual({ kind: "blocked", nextClaimAt: null });
    });

    it("429 with a nextClaimAt but a different error text", () => {
      expect(
        classifyPreFundRefusal({
          ...base,
          status: 429,
          body: { error: "something else", nextClaimAt: "later" },
          balance: short,
        }),
      ).toEqual({ kind: "blocked", nextClaimAt: "later" });
    });

    it("a non-string nextClaimAt is reported as null", () => {
      expect(
        classifyPreFundRefusal({
          ...base,
          status: 429,
          body: { error: PREFUND_GATE_ERROR, nextClaimAt: 1_763_254_800_000 },
          balance: short,
        }),
      ).toEqual({ kind: "blocked", nextClaimAt: null });
    });

    it("a zero balance inside the window", () => {
      expect(
        classifyPreFundRefusal({ ...base, status: 429, body: { error: PREFUND_GATE_ERROR }, balance: 0n }),
      ).toEqual({ kind: "blocked", nextClaimAt: null });
    });
  });

  describe("error", () => {
    const short = covers - 1n;

    it("429 from the per-IP or edge limiter (no gate text, no nextClaimAt)", () => {
      expect(
        classifyPreFundRefusal({ ...base, status: 429, body: { error: "Too many requests" }, balance: short }),
      ).toEqual({ kind: "error" });
    });

    it("429 with a null body", () => {
      expect(classifyPreFundRefusal({ ...base, status: 429, body: null, balance: short })).toEqual({
        kind: "error",
      });
    });

    it("429 with an empty body", () => {
      expect(classifyPreFundRefusal({ ...base, status: 429, body: {}, balance: short })).toEqual({
        kind: "error",
      });
    });

    it("429 whose nextClaimAt is not a string and whose error is not the gate text", () => {
      expect(
        classifyPreFundRefusal({ ...base, status: 429, body: { error: 7, nextClaimAt: null }, balance: short }),
      ).toEqual({ kind: "error" });
    });

    it.each([400, 403, 500, 503])("status %i even with the gate text and a nextClaimAt", (status) => {
      expect(
        classifyPreFundRefusal({
          ...base,
          status,
          body: { error: PREFUND_GATE_ERROR, nextClaimAt: "later" },
          balance: short,
        }),
      ).toEqual({ kind: "error" });
    });
  });
});
