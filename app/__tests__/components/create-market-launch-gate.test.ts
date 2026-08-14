/**
 * GH#2515 — the launch-button gate must require the backing seeds too.
 *
 * The Create Market launch also runs TopUpBackingBucket for BOTH domains,
 * pulling from the creator's wallet on top of the LP deposit and insurance.
 * The wizard's `totalTokensRequired` summed only LP + insurance, so it enabled
 * LAUNCH on a balance that cannot fund the flow. The launch then strands
 * mid-way — after M1/M2 have landed on chain and spent SOL.
 *
 * The wizard was the only place that got this wrong. These are the three that
 * already agreed, and are what the gate now has to match:
 *
 *   CostEstimate.tsx:132          lpNum + insNum + (lp * PCT / 100) * 2
 *   createMarketValidation.ts:163 (lpNum * PCT / 100) * 2
 *   useCreateMarket.ts:2704       lpCollateral + insuranceAmount + 2n * backingSeed
 *
 * The last is the authority: it is the pre-flight that actually blocks TX4, so
 * whatever it requires is what the creator must hold. This file pins the gate's
 * formula to it.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  backingSeedPerDomain,
  BACKING_SEED_MIN_ATOMS,
  BACKING_SEED_PCT_OF_LP,
} from "@/lib/market-params";

/** The gate as it now stands in CreateMarketWizard (`totalTokensRequired`). */
function gateRequires(lpRaw: bigint, insRaw: bigint): bigint {
  return lpRaw + insRaw + 2n * backingSeedPerDomain(lpRaw);
}

/** The gate as it was — the bug. */
function oldGateRequired(lpRaw: bigint, insRaw: bigint): bigint {
  return lpRaw + insRaw;
}

/** What useCreateMarket's TX4 pre-flight actually demands (`:2704`). */
function tx4Requires(lpRaw: bigint, insRaw: bigint): bigint {
  return lpRaw + insRaw + 2n * backingSeedPerDomain(lpRaw);
}

const DEC = 1_000_000_000n; // 9dp, the wizard's default token scale
const LP = 1_000n * DEC;
const INS = 100n * DEC;

describe("GH#2515: launch gate matches the TX4 pre-flight", () => {
  it("requires the two backing seeds, not just LP + insurance", () => {
    // The issue's own numbers: 1,000 LP + 100 insurance is a 3,100-token
    // launch at the current policy, not 1,100.
    expect(backingSeedPerDomain(LP)).toBe(LP); // 100% of LP today
    expect(oldGateRequired(LP, INS)).toBe(1_100n * DEC); // what it used to ask
    expect(gateRequires(LP, INS)).toBe(3_100n * DEC); // what a launch costs
  });

  it("agrees with the TX4 pre-flight for a spread of inputs", () => {
    const cases: [bigint, bigint][] = [
      [LP, INS],
      [1n * DEC, 0n],
      [0n, 0n],
      [50_000n * DEC, 1_234n * DEC],
      [7n * DEC, 3n * DEC],
    ];
    for (const [lp, ins] of cases) {
      expect(gateRequires(lp, ins)).toBe(tx4Requires(lp, ins));
    }
  });

  it("admits the balance that the old gate wrongly accepted, and no less", () => {
    // A creator holding exactly the old requirement must now be blocked —
    // that is the whole point. Anything at or above the real cost passes.
    const held = oldGateRequired(LP, INS);
    expect(held >= gateRequires(LP, INS)).toBe(false);
    expect(3_100n * DEC >= gateRequires(LP, INS)).toBe(true);
    expect(3_099n * DEC >= gateRequires(LP, INS)).toBe(false);
  });

  it("applies the minimum-seed floor a bare percentage would miss", () => {
    // backingSeedPerDomain floors at BACKING_SEED_MIN_ATOMS. Deriving the seed
    // straight from the percentage — as CostEstimate and createMarketValidation
    // do — under-requires for a tiny LP, which is why the gate uses the helper.
    const tinyLp = 1n;
    const barePercentage = (tinyLp * BACKING_SEED_PCT_OF_LP) / 100n;
    // At today's 100% policy the percentage of 1 atom is 1 atom — still far
    // below the floor, so the helper returns the floor and the bare formula
    // under-requires by ~10k atoms per domain. (Written as 0n first, which the
    // test caught: the percentage is 100, not something smaller.)
    expect(barePercentage).toBe(1n);
    expect(barePercentage).toBeLessThan(BACKING_SEED_MIN_ATOMS);
    expect(backingSeedPerDomain(tinyLp)).toBe(BACKING_SEED_MIN_ATOMS);
    expect(gateRequires(tinyLp, 0n)).toBe(1n + 2n * BACKING_SEED_MIN_ATOMS);
  });
});

/**
 * The cases above state the formula but cannot enforce it: they model the gate
 * in this file, so reverting the wizard leaves them green. Verified by mutation
 * — restoring `return lpRaw + insRaw;` failed nothing above.
 *
 * This binds it to the source. The whole fix is the `2n * backingSeedPerDomain`
 * term inside `totalTokensRequired`, so its presence is asserted directly; the
 * cases above are the explanation of what it has to equal.
 */
describe("the wizard gate actually includes the backing seeds", () => {
  const SRC = fs.readFileSync(
    path.resolve(__dirname, "../../components/create/CreateMarketWizard.tsx"),
    "utf8",
  );

  function totalTokensRequiredBody(): string {
    const start = SRC.indexOf("const totalTokensRequired");
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf("const hasSufficientTokensForSeed", start);
    expect(end).toBeGreaterThan(start);
    return SRC.slice(start, end);
  }

  it("adds 2n * backingSeedPerDomain(lpRaw) to LP + insurance", () => {
    const body = totalTokensRequiredBody();
    expect(body).toMatch(/2n\s*\*\s*backingSeedPerDomain\(\s*lpRaw\s*\)/);
    // and not the bare LP + insurance it used to be
    expect(body).not.toMatch(/return\s+lpRaw\s*\+\s*insRaw\s*;/);
  });

  it("uses the helper, not a re-derived percentage", () => {
    // A fourth copy of `lp * PCT / 100 * 2` would skip BACKING_SEED_MIN_ATOMS.
    const body = totalTokensRequiredBody();
    expect(body).toContain("backingSeedPerDomain");
    expect(body).not.toContain("BACKING_SEED_PCT_OF_LP");
  });
});
